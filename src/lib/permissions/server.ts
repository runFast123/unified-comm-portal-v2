import { createServiceRoleClient } from '@/lib/supabase-server'
import type { UserRole } from '@/types/database'
import {
  resolveEffectivePermissions,
  type RoleOverrideRow,
  type UserOverrideRow,
} from './resolve'

export interface PermissionUser {
  id: string
  role: UserRole
  company_id: string | null
}

/**
 * Load + resolve a user's effective permission set: the code baseline with
 * sparse DB overrides applied (platform role → company role → per-user).
 *
 * Uses the service-role client (RLS-bypassing) and scopes every read explicitly
 * by role / company_id / user_id in TS — matching the app's service-role
 * convention. super_admin short-circuits to all-access with no DB round-trip.
 */
export async function getEffectivePermissions(user: PermissionUser): Promise<Set<string>> {
  if (user.role === 'super_admin') return resolveEffectivePermissions('super_admin')

  const supabase = await createServiceRoleClient()

  // Role overrides: platform defaults (company_id IS NULL) + this company's rows.
  let roleQuery = supabase
    .from('role_permissions')
    .select('company_id, permission_key, allowed')
    .eq('role', user.role)
  roleQuery = user.company_id
    ? roleQuery.or(`company_id.is.null,company_id.eq.${user.company_id}`)
    : roleQuery.is('company_id', null)
  const { data: roleRows } = await roleQuery

  const platformRole: RoleOverrideRow[] = []
  const companyRole: RoleOverrideRow[] = []
  for (const r of (roleRows ?? []) as Array<{
    company_id: string | null
    permission_key: string
    allowed: boolean
  }>) {
    const row: RoleOverrideRow = { permission_key: r.permission_key, allowed: r.allowed }
    if (r.company_id) companyRole.push(row)
    else platformRole.push(row)
  }

  const { data: userRows } = await supabase
    .from('user_permissions')
    .select('permission_key, effect')
    .eq('user_id', user.id)
  const userOverrides: UserOverrideRow[] = (
    (userRows ?? []) as Array<{ permission_key: string; effect: 'allow' | 'deny' }>
  ).map((r) => ({ permission_key: r.permission_key, effect: r.effect }))

  return resolveEffectivePermissions(user.role, { platformRole, companyRole, user: userOverrides })
}

/** Convenience: does this user hold a single permission key? */
export async function userHasPermission(user: PermissionUser, key: string): Promise<boolean> {
  if (user.role === 'super_admin') return true
  return (await getEffectivePermissions(user)).has(key)
}

/**
 * For API routes that already authenticated the caller via the session: check a
 * permission by user id (loads role/company via service-role). super_admin is
 * always allowed. Returns false for an unknown user.
 */
export async function userIdCan(userId: string, permission: string): Promise<boolean> {
  const supabase = await createServiceRoleClient()
  const { data: profile } = await supabase
    .from('users')
    .select('role, company_id')
    .eq('id', userId)
    .maybeSingle()
  if (!profile) return false
  const role = ((profile as { role?: string }).role ?? 'viewer') as UserRole
  if (role === 'super_admin') return true
  const perms = await getEffectivePermissions({
    id: userId,
    role,
    company_id: (profile as { company_id?: string | null }).company_id ?? null,
  })
  return perms.has(permission)
}
