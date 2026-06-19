import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import { userIdCan } from '@/lib/permissions/server'
import { logAudit } from '@/lib/audit'

interface AdminCtx {
  userId: string
  role: string
  companyId: string | null
}

/**
 * Auth gate: caller must be super_admin OR a company-level admin.
 * Mirrors `src/app/api/users/delete/route.ts` verbatim so this recovery
 * endpoint enforces the EXACT same authentication surface (user client for
 * the session + service-role client to read the caller's own profile past
 * RLS). The fine-grained "who may reset whom" tenant rules are applied in POST.
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

/**
 * POST /api/admin/users/:id/reset-mfa
 *
 * Removes ALL of the target user's MFA factors so a locked-out user (lost
 * authenticator) can re-enroll. Supabase has no native recovery codes — this
 * admin-driven reset IS the recovery path.
 *
 * Who may reset (tenant scoping is the security boundary — identical to the
 * user delete route):
 *   - super_admin   → any user in any company.
 *   - company_admin (and legacy 'admin') → only users in their OWN company.
 *   - everyone else → blocked by requireAdmin() (403).
 *
 * Returns { ok: true, removed: <count> }. `removed` may be 0 when the user had
 * no factors (the reset is idempotent — re-running it is harmless).
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  // Same fine-grained permission the other user-admin mutations require.
  if (!(await userIdCan(gate.ctx.userId, 'action:users.manage'))) {
    return NextResponse.json({ error: 'Missing permission: action:users.manage' }, { status: 403 })
  }

  const { id: targetId } = await context.params
  if (!targetId || typeof targetId !== 'string') {
    return NextResponse.json({ error: 'User id required' }, { status: 400 })
  }

  const ctx = gate.ctx
  const isSuper = isSuperAdmin(ctx.role)

  const admin = await createServiceRoleClient()

  // Load the target via service role (bypasses RLS). We need its company_id to
  // enforce the tenant boundary below.
  const { data: target, error: targetErr } = await admin
    .from('users')
    .select('id, email, company_id')
    .eq('id', targetId)
    .maybeSingle()
  if (targetErr) {
    return NextResponse.json({ error: targetErr.message }, { status: 500 })
  }
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const targetCompanyId = (target as { company_id?: string | null }).company_id ?? null

  // Tenant bound — non-super_admin may only reset users in their OWN company.
  // (Copied from the delete route's Guard 2.) A super_admin bypasses this.
  if (!isSuper) {
    if (!ctx.companyId) {
      return NextResponse.json(
        { error: 'Forbidden: caller has no company' },
        { status: 403 }
      )
    }
    if (targetCompanyId !== ctx.companyId) {
      return NextResponse.json(
        { error: 'Forbidden: cross-company access denied' },
        { status: 403 }
      )
    }
  }

  // Remove the factors via the service-role admin MFA API. @supabase/auth-js
  // (installed 2.99.3) exposes `auth.admin.mfa.{listFactors,deleteFactor}`,
  // so no SQL fallback is needed. listFactors returns every factor (verified
  // and unverified); we delete each so a locked-out user starts from a clean
  // slate. Deleting a verified factor also logs the user out of active
  // sessions (GoTrue behavior) — desirable here.
  const { data: list, error: listErr } = await admin.auth.admin.mfa.listFactors({
    userId: targetId,
  })
  if (listErr) {
    return NextResponse.json(
      { error: `Could not list MFA factors: ${listErr.message}` },
      { status: 500 }
    )
  }

  const factors = list?.factors ?? []
  let removed = 0
  for (const factor of factors) {
    const { error: delErr } = await admin.auth.admin.mfa.deleteFactor({
      id: factor.id,
      userId: targetId,
    })
    if (delErr) {
      return NextResponse.json(
        {
          error: `Removed ${removed} factor(s), then failed on one: ${delErr.message}`,
        },
        { status: 500 }
      )
    }
    removed++
  }

  // Audit. company_id resolved like the other admin user routes: scope the row
  // to the TARGET's company so that company's admins see it too (and so a
  // super_admin's NULL home company_id doesn't hide it). entity = the target.
  await logAudit({
    user_id: ctx.userId,
    company_id: targetCompanyId,
    action: 'user_mfa_reset',
    entity_type: 'user',
    entity_id: targetId,
    details: {
      reset_email: (target as { email: string }).email,
      removed,
      actor_id: ctx.userId,
    },
  })

  return NextResponse.json({ ok: true, removed })
}
