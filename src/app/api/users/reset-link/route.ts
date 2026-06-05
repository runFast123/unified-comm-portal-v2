import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

interface AdminCtx {
  userId: string
  role: string
  companyId: string | null
}

/**
 * Auth gate: caller must be super_admin OR a company-level admin.
 * Mirrors src/app/api/users/invite/route.ts.
 */
async function requireAdmin(): Promise<
  | { ok: true; ctx: AdminCtx }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }

  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role, company_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile?.role) return { ok: false, status: 403, error: 'Admin only' }
  const role = profile.role as string
  if (!isSuperAdmin(role) && !isCompanyAdmin(role)) {
    return { ok: false, status: 403, error: 'Admin only' }
  }
  return {
    ok: true,
    ctx: {
      userId: user.id,
      role,
      companyId: (profile as { company_id?: string | null }).company_id ?? null,
    },
  }
}

interface ResetLinkBody {
  user_id?: string
  email?: string
}

/**
 * POST /api/users/reset-link
 * Body: { user_id } | { email }
 *
 * Mints a FRESH "set / reset password" link for an existing user (or a pending
 * invitation) and hands it back to the admin to share.
 *
 * It uses our OWN setup token (table public.password_setup_tokens), NOT a GoTrue
 * recovery/invite link. GoTrue links are single-use AND consumed on the first
 * GET, so a link preview / email scanner / browser prefetch burns them before
 * the human ever clicks ("the link is already expired"). Our token is consumed
 * only on the password SUBMIT (POST /api/auth/set-password), has a 72h TTL we
 * control, and is stored as a SHA-256 hash. The link lands on
 * /accept-invite#setup=<token>; the set-password step confirms the user's email
 * (no "Email not confirmed" wall, no SMTP needed).
 *
 * Tenant scoping: a company_admin may only mint links for users in their OWN
 * company; super_admin may target anyone. The target is resolved server-side
 * from user_id (or email) so the caller can't spoof another tenant's user.
 */
export async function POST(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: ResetLinkBody
  try {
    body = (await request.json()) as ResetLinkBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()
  const isSuper = isSuperAdmin(gate.ctx.role)

  // ── Resolve the target email + owning company (for tenant scoping) ─────────
  // Prefer a real public.users row (looked up by id or email); fall back to a
  // pending user_invitations row when no auth user exists yet.
  let email: string | null = null
  let targetCompanyId: string | null = null
  let fullName: string | null = null
  let authUserId: string | null = null

  if (typeof body.user_id === 'string' && body.user_id.trim()) {
    const { data: u, error: uErr } = await admin
      .from('users')
      .select('id, email, company_id, full_name')
      .eq('id', body.user_id.trim())
      .maybeSingle()
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })
    if (!u) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    authUserId = (u as { id: string }).id
    email = (u as { email: string }).email
    targetCompanyId = (u as { company_id?: string | null }).company_id ?? null
    fullName = (u as { full_name?: string | null }).full_name ?? null
  } else if (typeof body.email === 'string' && body.email.trim()) {
    email = body.email.trim().toLowerCase()
    // Real user first (authoritative company), else the pending invitation row.
    const { data: u } = await admin
      .from('users')
      .select('id, company_id, full_name')
      .eq('email', email)
      .maybeSingle()
    if (u) {
      authUserId = (u as { id: string }).id
      targetCompanyId = (u as { company_id?: string | null }).company_id ?? null
      fullName = (u as { full_name?: string | null }).full_name ?? null
    } else {
      const { data: inv } = await admin
        .from('user_invitations')
        .select('company_id, full_name')
        .eq('email', email)
        .maybeSingle()
      targetCompanyId = (inv as { company_id?: string | null } | null)?.company_id ?? null
      fullName = (inv as { full_name?: string | null } | null)?.full_name ?? null
    }
  } else {
    return NextResponse.json({ error: 'user_id or email required' }, { status: 400 })
  }

  if (!email) {
    return NextResponse.json({ error: 'Could not resolve a target email' }, { status: 400 })
  }

  // Tenant scoping: a company_admin can only mint links for their own company.
  if (!isSuper) {
    if (!gate.ctx.companyId || targetCompanyId !== gate.ctx.companyId) {
      return NextResponse.json(
        { error: 'Forbidden: that user is not in your company' },
        { status: 403 }
      )
    }
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://project-0stjf.vercel.app'
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  // For a still-pending invitation (no auth user yet) create the auth account so
  // the setup token has a user to point at. The handle_new_auth_user trigger
  // creates the public.users row (and consumes the matching user_invitations
  // row). email_confirm:false — the set-password step confirms it.
  if (!authUserId) {
    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json({ error: 'Server is misconfigured.' }, { status: 500 })
    }
    try {
      const r = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          email_confirm: false,
          ...(fullName ? { user_metadata: { full_name: fullName } } : {}),
        }),
      })
      const j = (await r.json().catch(() => null)) as { id?: string } | null
      authUserId = j?.id ?? null
    } catch {
      authUserId = null
    }
    if (!authUserId) {
      return NextResponse.json({ error: 'Could not create the user account.' }, { status: 502 })
    }
  }

  // Mint a custom, prefetch-safe setup token (consumed on POST, not GET). 72h TTL.
  const rawToken = crypto.randomBytes(32).toString('base64url')
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
  const { error: tokErr } = await admin.from('password_setup_tokens').insert({
    user_id: authUserId,
    token_hash: tokenHash,
    expires_at: expiresAt,
    created_by: gate.ctx.userId,
  })
  if (tokErr) {
    return NextResponse.json({ error: 'Could not create the setup link.' }, { status: 500 })
  }

  // Token rides in the URL HASH so it never reaches server logs / the Referer
  // header; /accept-invite reads it, strips it from the URL, and submits it.
  const link = `${siteUrl}/accept-invite#setup=${rawToken}`

  await admin.from('audit_log').insert({
    user_id: gate.ctx.userId,
    action: 'user.reset_link',
    entity_type: 'user',
    entity_id: authUserId,
    details: { email, actor_id: gate.ctx.userId, company_id: targetCompanyId, method: 'setup_token' },
  })

  return NextResponse.json({ success: true, email, link })
}
