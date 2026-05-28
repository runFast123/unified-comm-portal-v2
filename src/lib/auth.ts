// ─── Multi-tenancy auth helpers ──────────────────────────────────────
//
// Server-side helpers that wrap the user/company lookups used by the
// dashboard pages and API routes. All of them use the service-role client
// so they can read past RLS — every caller is expected to have already
// authenticated the user via `createServerSupabaseClient().auth.getUser()`.
//
// Role model (post multi-tenancy migration):
//   - super_admin   → cross-tenant; bypasses company scope everywhere.
//   - admin         → legacy; treated as company_admin going forward.
//   - company_admin → manage their own company.
//   - supervisor    → medium-trust tier between admin and member (Phase 1
//                     preparation only; not yet enforced anywhere).
//   - company_member → read/write within their own company.
//   - reviewer / viewer → legacy roles, kept for back-compat.
//
// `is_super_admin()` is the privilege check; everything else is scoped to
// `current_user_company_id()` at the DB layer (see RLS policies). These
// helpers exist so code paths that bypass RLS (service-role route handlers,
// server components) can replicate the same scoping logic in TypeScript.

import { createServiceRoleClient } from '@/lib/supabase-server'
import type { UserRole } from '@/types/database'

/** Role values that are treated as super_admin (cross-tenant). */
const SUPER_ADMIN_ROLES: ReadonlySet<string> = new Set(['super_admin'])

/** Role values that have admin privileges within their own company. */
const COMPANY_ADMIN_ROLES: ReadonlySet<string> = new Set([
  'super_admin',
  'admin',
  'company_admin',
])

/**
 * Role values that are supervisor-or-above (super-set of COMPANY_ADMIN_ROLES
 * plus the new 'supervisor' tier).
 */
const SUPERVISOR_ROLES: ReadonlySet<string> = new Set([
  'super_admin',
  'admin',
  'company_admin',
  'supervisor',
])

/**
 * Returns true if the role string is super_admin (cross-tenant).
 * Pure function — accepts a string so callers can pass `user.role` from
 * any source without an extra await.
 */
export function isSuperAdmin(role: string | null | undefined): boolean {
  return !!role && SUPER_ADMIN_ROLES.has(role)
}

/**
 * Returns true if the role string is a company-level admin (admin / company_admin
 * / super_admin). Used to gate "manage company" UI / endpoints.
 */
export function isCompanyAdmin(role: string | null | undefined): boolean {
  return !!role && COMPANY_ADMIN_ROLES.has(role)
}

// True for supervisor or above. Use to gate medium-trust ops (assign, merge,
// approve AI) that go beyond agent-level reply but aren't full admin.
//
// PHASE 1 PREPARATION ONLY — the supervisor role exists in the schema and the
// helper is available, but no API endpoints or RLS policies enforce it yet.
// Phase 2 will gate destructive ops (assign, merge, CSAT send, AI approve)
// behind isSupervisor().
export function isSupervisor(role: string | null | undefined): boolean {
  return !!role && SUPERVISOR_ROLES.has(role)
}

export interface CurrentUser {
  id: string
  email: string
  full_name: string | null
  role: UserRole | string
  account_id: string | null
  company_id: string | null
}

/**
 * Returns the public.users row for the given auth user id, joined with the
 * minimum fields needed to make multi-tenancy decisions. Uses the service
 * role client so it works inside server components / server actions.
 *
 * Returns null if the user doesn't exist in `public.users` yet (e.g.
 * mid-signup, before the trigger has fired).
 */
export async function getCurrentUser(
  userId: string
): Promise<CurrentUser | null> {
  if (!userId) return null
  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('users')
    .select('id, email, full_name, role, account_id, company_id')
    .eq('id', userId)
    .maybeSingle()
  if (error || !data) return null
  return data as CurrentUser
}

/**
 * Returns the company row for the given user id, or null if the user
 * isn't attached to a company. Convenience wrapper around getCurrentUser
 * → companies lookup.
 */
export async function getUserCompany(userId: string): Promise<{
  id: string
  name: string
  slug: string | null
  logo_url: string | null
  accent_color: string | null
} | null> {
  const user = await getCurrentUser(userId)
  if (!user?.company_id) return null
  const admin = await createServiceRoleClient()
  const { data } = await admin
    .from('companies')
    .select('id, name, slug, logo_url, accent_color')
    .eq('id', user.company_id)
    .maybeSingle()
  return (data as {
    id: string
    name: string
    slug: string | null
    logo_url: string | null
    accent_color: string | null
  } | null) ?? null
}

/**
 * Returns the set of account ids the user is allowed to access.
 *   - super_admin → returns null (meaning: no scope; allow everything).
 *   - users with a company_id → returns all accounts in that company.
 *   - users with no company_id but an account_id → returns just that one.
 *   - users with neither → returns an empty set (deny everything).
 *
 * Callers should treat `null` as the all-access sentinel:
 *
 *     const allowed = await getAllowedAccountIds(userId)
 *     if (allowed && !allowed.has(accountId)) notFound()
 */
export async function getAllowedAccountIds(
  userId: string
): Promise<Set<string> | null> {
  const user = await getCurrentUser(userId)
  if (!user) return new Set()
  if (isSuperAdmin(user.role)) return null

  const admin = await createServiceRoleClient()
  if (user.company_id) {
    const { data } = await admin
      .from('accounts')
      .select('id')
      .eq('company_id', user.company_id)
    const ids = (data ?? []).map((a: { id: string }) => a.id)
    if (user.account_id && !ids.includes(user.account_id)) ids.push(user.account_id)
    return new Set(ids)
  }
  if (user.account_id) return new Set([user.account_id])
  return new Set()
}
