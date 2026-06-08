import type { UserRole } from '@/types/database'
import { DEFAULT_ROLE_PERMISSIONS } from './defaults'

/** A sparse role-level override row (platform-wide or company-scoped). */
export interface RoleOverrideRow {
  permission_key: string
  allowed: boolean
}

/** A sparse per-user override row (highest precedence). */
export interface UserOverrideRow {
  permission_key: string
  effect: 'allow' | 'deny'
}

/**
 * Compute a user's effective permission set.
 *
 * Start from the code-defined role baseline, then apply sparse DB overrides in
 * increasing precedence:
 *   platform role override → company role override → per-user override (wins).
 *
 * super_admin is unconditionally all-access — overrides never remove anything,
 * so the platform owner can never lock themselves (or be locked) out.
 */
export function resolveEffectivePermissions(
  role: UserRole,
  layers: {
    platformRole?: RoleOverrideRow[]
    companyRole?: RoleOverrideRow[]
    user?: UserOverrideRow[]
  } = {}
): Set<string> {
  const eff = new Set(DEFAULT_ROLE_PERMISSIONS[role] ?? [])
  if (role === 'super_admin') return eff // all-access, not overridable

  const apply = (key: string, allowed: boolean) => {
    if (allowed) eff.add(key)
    else eff.delete(key)
  }
  for (const o of layers.platformRole ?? []) apply(o.permission_key, o.allowed)
  for (const o of layers.companyRole ?? []) apply(o.permission_key, o.allowed)
  for (const o of layers.user ?? []) apply(o.permission_key, o.effect === 'allow')
  return eff
}

/**
 * Whether a resolved permission set grants `key`. Pass the role so super_admin
 * short-circuits to always-true even if the caller built the set oddly.
 */
export function setHasPermission(
  perms: Set<string>,
  key: string,
  role?: UserRole
): boolean {
  if (role === 'super_admin') return true
  return perms.has(key)
}
