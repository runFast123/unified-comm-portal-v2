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
 * plus the 'supervisor' tier).
 */
const SUPERVISOR_ROLES: ReadonlySet<string> = new Set([
  'super_admin',
  'admin',
  'company_admin',
  'supervisor',
])

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
