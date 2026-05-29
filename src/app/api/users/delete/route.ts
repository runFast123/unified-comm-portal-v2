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
 * Copied verbatim from `src/app/api/users/invite/route.ts` so the delete
 * endpoint enforces the exact same authentication surface (createServerSupabase
 * for the session + createServiceRole to read the caller's own profile past
 * RLS). The fine-grained "who may delete whom" rules are applied in POST.
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
  if (!profile?.role) {
    return { ok: false, status: 403, error: 'Admin only' }
  }
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

interface DeleteBody {
  user_id?: string
  invitation_email?: string
}

/**
 * POST /api/users/delete
 * Body: exactly one of { user_id } | { invitation_email }.
 *
 *   - user_id           → permanently delete a real user (auth + profile row).
 *   - invitation_email  → revoke a pending pre-registration (user_invitations).
 *
 * Who may delete:
 *   - super_admin   → any user / any pending invite in any company.
 *   - company_admin (and legacy 'admin') → only within their OWN company, and
 *     may NOT delete a super_admin or a legacy 'admin'.
 *   - everyone else → blocked by requireAdmin() above (403).
 *
 * Hard guardrails (enforced below for the user_id path):
 *   1. No self-delete.
 *   2. company_admin: target.company_id === caller.companyId AND target is not
 *      super_admin / legacy admin.
 *   3. Last-super-admin guard: can't delete the final active super_admin.
 *   4. Every delete is audit-logged.
 */
export async function POST(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: DeleteBody
  try {
    body = (await request.json()) as DeleteBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const ctx = gate.ctx
  const isSuper = isSuperAdmin(ctx.role)

  const hasUserId = typeof body.user_id === 'string' && body.user_id.length > 0
  const hasInviteEmail =
    typeof body.invitation_email === 'string' && body.invitation_email.trim().length > 0

  // Require EXACTLY one of the two selectors.
  if (hasUserId === hasInviteEmail) {
    return NextResponse.json(
      { error: 'Provide exactly one of user_id or invitation_email.' },
      { status: 400 }
    )
  }

  const admin = await createServiceRoleClient()

  // ── Revoke a pending invitation ─────────────────────────────────────────
  // These rows live in user_invitations keyed by (lowercased) email and have
  // no public.users row yet. super_admin may revoke any; company_admin only
  // their own tenant's (so they can't cancel another company's invite by
  // guessing the email).
  if (hasInviteEmail) {
    const email = (body.invitation_email as string).trim().toLowerCase()

    let delQuery = admin.from('user_invitations').delete().eq('email', email)
    if (!isSuper) {
      if (!ctx.companyId) {
        return NextResponse.json(
          { error: 'Forbidden: caller has no company' },
          { status: 403 }
        )
      }
      delQuery = delQuery.eq('company_id', ctx.companyId)
    }

    const { error: delErr } = await delQuery
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 })
    }

    await admin.from('audit_log').insert({
      user_id: ctx.userId,
      action: 'user.invitation.revoke',
      entity_type: 'user_invitation',
      entity_id: null,
      details: { revoked_email: email, actor_id: ctx.userId },
    })

    return NextResponse.json({ success: true, deleted: 'invitation' })
  }

  // ── Delete a real user ──────────────────────────────────────────────────
  const userId = body.user_id as string

  // Guard 1 — no self-delete.
  if (userId === ctx.userId) {
    return NextResponse.json(
      { error: "You can't delete your own account." },
      { status: 400 }
    )
  }

  // Load the target via service role (bypasses RLS).
  const { data: target, error: targetErr } = await admin
    .from('users')
    .select('id, email, role, company_id')
    .eq('id', userId)
    .maybeSingle()
  if (targetErr) {
    return NextResponse.json({ error: targetErr.message }, { status: 500 })
  }
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const targetRole = (target as { role: string }).role
  const targetCompanyId = (target as { company_id?: string | null }).company_id ?? null

  // Guard 2 — company_admin tenant + privilege bound.
  if (!isSuper) {
    if (!ctx.companyId) {
      return NextResponse.json(
        { error: 'Forbidden: caller has no company' },
        { status: 403 }
      )
    }
    if (targetCompanyId !== ctx.companyId) {
      return NextResponse.json(
        { error: 'Forbidden: cross-company delete denied' },
        { status: 403 }
      )
    }
    // A company_admin must never be able to remove a super_admin or a legacy
    // cross-tenant 'admin' — only a super_admin can touch those.
    if (isSuperAdmin(targetRole) || targetRole === 'admin') {
      return NextResponse.json(
        { error: 'Forbidden: cannot delete an admin of this rank' },
        { status: 403 }
      )
    }
  }

  // Guard 3 — last-super-admin guard. If we're deleting a super_admin, make
  // sure at least one other active super_admin survives.
  if (isSuperAdmin(targetRole)) {
    const { count, error: countErr } = await admin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'super_admin')
      .eq('is_active', true)
    if (countErr) {
      return NextResponse.json({ error: countErr.message }, { status: 500 })
    }
    if ((count ?? 0) <= 1) {
      return NextResponse.json(
        { error: 'Cannot delete the last super admin.' },
        { status: 409 }
      )
    }
  }

  // Delete the GoTrue auth user via the admin REST endpoint (consistent with
  // the invite route, which talks to GoTrue over REST). A 404 here is
  // non-fatal — the auth user may already be gone (e.g. a pre-registered row
  // that never completed signup, or a prior partial delete).
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (supabaseUrl && serviceKey) {
    try {
      const r = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      })
      if (!r.ok && r.status !== 404) {
        const detail = await r.text().catch(() => '')
        return NextResponse.json(
          { error: `Failed to delete auth user${detail ? `: ${detail}` : ''}` },
          { status: 500 }
        )
      }
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to delete auth user' },
        { status: 500 }
      )
    }
  }

  // Delete the profile row. Idempotent — deleting the auth user above may have
  // already cascaded this away, in which case this affects zero rows.
  const { error: profileDelErr } = await admin.from('users').delete().eq('id', userId)
  if (profileDelErr) {
    return NextResponse.json({ error: profileDelErr.message }, { status: 500 })
  }

  // Guard 4 — audit.
  await admin.from('audit_log').insert({
    user_id: ctx.userId,
    action: 'user.delete',
    entity_type: 'user',
    entity_id: userId,
    details: {
      deleted_email: (target as { email: string }).email,
      deleted_role: targetRole,
      actor_id: ctx.userId,
    },
  })

  return NextResponse.json({
    success: true,
    deleted: 'user',
    email: (target as { email: string }).email,
  })
}
