import { NextResponse } from 'next/server'
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
 * Mints a FRESH "set / reset password" action link for an existing user (or a
 * pending invitation) and hands it back to the admin to share. This closes a
 * real gap: Supabase invite/recovery tokens are SINGLE-USE and time-limited, so
 * once the original invite link is clicked (or expires) there was previously no
 * way to produce a working link again — re-inviting an existing user only
 * updates their role (it doesn't regenerate a link). Admins were stranded.
 *
 * The link points at /accept-invite (set-password form) and AUTO-CONFIRMS the
 * user's email when clicked, so there's no "Email not confirmed" wall. Uses
 * GoTrue's admin `generate_link` (no email sent, no SMTP/quota needed), exactly
 * like the invite route.
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

  if (typeof body.user_id === 'string' && body.user_id.trim()) {
    const { data: u, error: uErr } = await admin
      .from('users')
      .select('email, company_id, full_name')
      .eq('id', body.user_id.trim())
      .maybeSingle()
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })
    if (!u) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    email = (u as { email: string }).email
    targetCompanyId = (u as { company_id?: string | null }).company_id ?? null
    fullName = (u as { full_name?: string | null }).full_name ?? null
  } else if (typeof body.email === 'string' && body.email.trim()) {
    email = body.email.trim().toLowerCase()
    // Real user first (authoritative company), else the pending invitation row.
    const { data: u } = await admin
      .from('users')
      .select('company_id, full_name')
      .eq('email', email)
      .maybeSingle()
    if (u) {
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

  // Generate an action link WITHOUT sending email. The link auto-confirms the
  // user's email when clicked and lands them on /accept-invite to set a
  // password. type=recovery works for an existing auth user (the common case);
  // type=invite is the fallback that creates the auth user if one doesn't exist
  // yet (e.g. a still-pending invitation).
  async function genLink(type: 'recovery' | 'invite'): Promise<string | null> {
    if (!supabaseUrl || !serviceKey) return null
    try {
      const r = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type,
          email,
          ...(fullName ? { data: { full_name: fullName } } : {}),
          options: { redirect_to: `${siteUrl}/accept-invite` },
        }),
      })
      if (!r.ok) return null
      const j = (await r.json().catch(() => null)) as
        | { action_link?: string; properties?: { action_link?: string } }
        | null
      return j?.action_link ?? j?.properties?.action_link ?? null
    } catch {
      return null
    }
  }

  const link = (await genLink('recovery')) ?? (await genLink('invite'))
  if (!link) {
    return NextResponse.json(
      {
        error:
          'Could not generate a link. Verify SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL are configured.',
      },
      { status: 502 }
    )
  }

  await admin.from('audit_log').insert({
    user_id: gate.ctx.userId,
    action: 'user.reset_link',
    entity_type: 'user',
    entity_id: typeof body.user_id === 'string' ? body.user_id : null,
    details: { email, actor_id: gate.ctx.userId, company_id: targetCompanyId },
  })

  return NextResponse.json({ success: true, email, link })
}
