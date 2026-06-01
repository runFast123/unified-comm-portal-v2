// Pure role predicates — safe to import from BOTH client and server code.
//
// `src/lib/auth.ts` re-exports these for back-compat with existing server
// callers, but `auth.ts` itself pulls in the service-role Supabase client
// (server-only). Client components must import from THIS file directly to
// avoid bundling server code into the browser.
//
// Role model (post multi-tenancy migration):
//   - super_admin   → cross-tenant; bypasses company scope everywhere.
//   - admin         → legacy; treated as company_admin going forward.
//   - company_admin → manage their own company.
//   - supervisor    → medium-trust tier between admin and member.
//                     Can assign, merge, send CSAT, approve AI replies.
//   - company_member → read/write within their own company (no destructive ops).
//   - reviewer / viewer → legacy roles, kept for back-compat.

// ─── Canonical role-name lists ───────────────────────────────────────
// The predicate functions below build their lookup Sets from these arrays,
// and callers that need literal role values for a Supabase `.in('role', …)`
// filter (which can't call a predicate function) import the arrays directly.
// One source of truth either way — keep additions here, not at call sites.

/** Roles with company-admin privileges (admin/company_admin/super_admin). */
export const COMPANY_ADMIN_ROLE_NAMES: readonly string[] = [
  'super_admin',
  'admin',
  'company_admin',
]

/**
 * Roles eligible to receive an auto-assigned conversation: every staff tier
 * that can actually work a ticket (read/write), across the modern and legacy
 * naming schemes. Read-only `viewer` and cross-tenant `super_admin` are
 * intentionally excluded — the latter is a platform operator, not company
 * staff, and is normally filtered out by company scope anyway.
 */
export const ASSIGNABLE_AGENT_ROLE_NAMES: readonly string[] = [
  // modern
  'company_admin',
  'supervisor',
  'company_member',
  // legacy
  'admin',
  'reviewer',
]

/** Role values that are treated as super_admin (cross-tenant). */
const SUPER_ADMIN_ROLES: ReadonlySet<string> = new Set(['super_admin'])

/** Role values that have admin privileges within their own company. */
const COMPANY_ADMIN_ROLES: ReadonlySet<string> = new Set(COMPANY_ADMIN_ROLE_NAMES)

/**
 * Role values that are supervisor-or-above (super-set of COMPANY_ADMIN_ROLES
 * plus the 'supervisor' tier).
 */
const SUPERVISOR_ROLES: ReadonlySet<string> = new Set([
  ...COMPANY_ADMIN_ROLE_NAMES,
  'supervisor',
])

/** Role values eligible to be auto-assigned conversations. */
const ASSIGNABLE_AGENT_ROLES: ReadonlySet<string> = new Set(
  ASSIGNABLE_AGENT_ROLE_NAMES
)

/** True if the role string is super_admin (cross-tenant). */
export function isSuperAdmin(role: string | null | undefined): boolean {
  return !!role && SUPER_ADMIN_ROLES.has(role)
}

/** True if the role string is a company-level admin (admin/company_admin/super_admin). */
export function isCompanyAdmin(role: string | null | undefined): boolean {
  return !!role && COMPANY_ADMIN_ROLES.has(role)
}

/**
 * True for supervisor or above. Use to gate medium-trust ops (assign-to-other,
 * merge/unmerge, CSAT send, AI approve/reject) that go beyond agent-level
 * reply but aren't full admin. `company_member` returns false.
 */
export function isSupervisor(role: string | null | undefined): boolean {
  return !!role && SUPERVISOR_ROLES.has(role)
}

/**
 * True if the role can be auto-assigned conversations — i.e. it belongs to a
 * company staff tier that works tickets. See ASSIGNABLE_AGENT_ROLE_NAMES for
 * what's included (and what's deliberately not).
 */
export function isAssignableAgent(role: string | null | undefined): boolean {
  return !!role && ASSIGNABLE_AGENT_ROLES.has(role)
}
