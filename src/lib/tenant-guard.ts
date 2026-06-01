// ─── Centralized tenant-scoping guard ───────────────────────────────
//
// THE TENANCY CONTRACT (read this before writing a service-role route):
//
//   Row-Level Security (RLS) scopes every query to the caller's company at
//   the DB layer — but ONLY when you talk to Postgres through the *user*
//   client (`createServerSupabaseClient`). The moment a route reaches for
//   `createServiceRoleClient()` (which it must, to write audit rows, read
//   another user's profile, bypass a view, etc.) RLS is OFF. There is no
//   safety net left: a `.eq('id', accountId)` will happily return — or
//   mutate — another tenant's row if `accountId` came from the request.
//
//   This module is the single, well-tested choke point that re-implements
//   that scoping in TypeScript so service-role routes can't silently forget
//   it. It consolidates the half-dozen bespoke `requireAdmin()` copies that
//   used to live inline in individual route handlers (channels/config,
//   accounts, …) behind one import, and it deliberately returns the SAME
//   `{ ok: true, ... } | { ok: false, status, error }` discriminated shape
//   those copies used, so adopting it is a drop-in replacement.
//
// HOW TO USE IT IN A ROUTE:
//
//   const gate = await requireCompanyAdmin()
//   if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
//   // ...gate.ctx is a fully-typed TenantContext...
//   if (!(await assertAccountAccess(gate.ctx, accountId))) {
//     return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
//   }
//
// Authentication always flows through the *user* client's `auth.getUser()`
// (which reads the request's session cookie); role/company are then loaded
// with the service-role client so the lookup works even for routes that run
// outside an RLS-readable context. Role predicates come from `@/lib/roles`
// (the single source of truth for the role model — super_admin is
// cross-tenant and bypasses company scope everywhere).

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isSuperAdmin, isCompanyAdmin, isSupervisor } from '@/lib/roles'
// `getAllowedAccountIds` lives in @/lib/auth; `verifyAccountAccess` lives in
// @/lib/api-helpers — import each from its real home (auth does NOT re-export
// verifyAccountAccess).
import { getAllowedAccountIds } from '@/lib/auth'
import { verifyAccountAccess } from '@/lib/api-helpers'

/**
 * The authenticated caller's tenancy context. Returned inside the `ok: true`
 * branch of the guard functions and threaded into the per-resource access
 * helpers below.
 *
 *   - `userId`       — the auth user id (also the `public.users` PK).
 *   - `role`         — the raw role string from `public.users` (may be a
 *                      modern or legacy role name; use the predicates rather
 *                      than comparing strings).
 *   - `companyId`    — the caller's company, or null for super_admins and
 *                      legacy single-account users with no company attached.
 *   - `isSuperAdmin` — convenience flag (cross-tenant; bypasses company scope).
 */
export type TenantContext = {
  userId: string
  role: string
  companyId: string | null
  isSuperAdmin: boolean
}

/** Discriminated result shared by every guard — mirrors the legacy
 *  `requireAdmin()` shape so this is a drop-in replacement. */
export type GuardResult =
  | { ok: true; ctx: TenantContext }
  | { ok: false; status: number; error: string }

/**
 * Authenticate the request and load the caller's tenancy context.
 *
 * Auth flows through the *user* client's `auth.getUser()` (reads the session
 * cookie); the `public.users` row is then loaded via the service-role client
 * so role/company resolve even when RLS would otherwise hide the row.
 *
 *   - No active session                → `{ ok: false, status: 401, error: 'Unauthorized' }`.
 *   - Session but no `public.users` row → `{ ok: false, status: 401, error: 'Unauthorized' }`
 *     (e.g. mid-signup, before the provisioning trigger has fired — there is
 *     no tenancy context to act on, so treat it as unauthenticated).
 *   - Otherwise                         → `{ ok: true, ctx }`.
 */
export async function requireUser(): Promise<GuardResult> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }

  const admin = await createServiceRoleClient()
  const { data: profile, error } = await admin
    .from('users')
    .select('role, company_id')
    .eq('id', user.id)
    .maybeSingle()

  if (error || !profile) {
    // Authenticated at the auth layer but with no tenancy row to scope
    // against — there's nothing safe to authorize, so reject as 401.
    return { ok: false, status: 401, error: 'Unauthorized' }
  }

  const role = (profile.role as string | null) ?? ''
  const ctx: TenantContext = {
    userId: user.id,
    role,
    companyId: (profile.company_id as string | null) ?? null,
    isSuperAdmin: isSuperAdmin(role),
  }
  return { ok: true, ctx }
}

/**
 * Like {@link requireUser}, but additionally requires the caller to hold
 * company-admin privileges (admin / company_admin / super_admin).
 *
 *   - Not authenticated → 401 'Unauthorized' (from requireUser).
 *   - Authenticated but not an admin → `{ ok: false, status: 403, error: 'Admin only' }`.
 */
export async function requireCompanyAdmin(): Promise<GuardResult> {
  const gate = await requireUser()
  if (!gate.ok) return gate
  if (!isCompanyAdmin(gate.ctx.role)) {
    return { ok: false, status: 403, error: 'Admin only' }
  }
  return gate
}

/**
 * Like {@link requireUser}, but requires supervisor-or-above (supervisor plus
 * every company-admin role). Use for medium-trust operations that go beyond
 * agent-level reply but aren't full admin (assign-to-other, merge/unmerge,
 * CSAT send, AI approve/reject).
 *
 *   - Not authenticated → 401 'Unauthorized'.
 *   - Authenticated but below supervisor → `{ ok: false, status: 403, error: 'Admin only' }`.
 */
export async function requireSupervisor(): Promise<GuardResult> {
  const gate = await requireUser()
  if (!gate.ok) return gate
  if (!isSupervisor(gate.ctx.role)) {
    return { ok: false, status: 403, error: 'Admin only' }
  }
  return gate
}

/**
 * True if `ctx` may access `accountId` (same company, the caller's own
 * account, or super_admin cross-tenant). Thin wrapper over
 * `verifyAccountAccess` so routes guarded by this module never have to import
 * a second access helper — the tenancy decision stays in one place.
 *
 * Call this AFTER a guard whenever a request carries an `account_id` that the
 * service-role client will read or mutate.
 */
export async function assertAccountAccess(
  ctx: TenantContext,
  accountId: string
): Promise<boolean> {
  return verifyAccountAccess(ctx.userId, accountId)
}

/**
 * The set of account ids `ctx` is allowed to touch, or `null` for the
 * all-access sentinel (super_admin — no scope). Delegates to
 * `getAllowedAccountIds`. Use to scope a list query:
 *
 *     const allowed = await tenantAccountIds(gate.ctx)
 *     const rows = base.filter(r => !allowed || allowed.has(r.account_id))
 */
export async function tenantAccountIds(
  ctx: TenantContext
): Promise<Set<string> | null> {
  return getAllowedAccountIds(ctx.userId)
}
