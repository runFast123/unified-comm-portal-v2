import { ROUTE_TO_SECTION, SECTION_PERMISSIONS, type SectionPermission } from './catalog'

/** Admin section permission keys (`section:admin.*`). */
export const ADMIN_SECTION_KEYS: string[] = Object.keys(SECTION_PERMISSIONS).filter((k) =>
  k.startsWith('section:admin.')
)

/**
 * Map a pathname to its section permission key. Exact match first, then a prefix
 * match so nested routes (/admin/channels/<id>, /reports/x) inherit their parent
 * section. Returns null for routes with no gated section (detail pages, etc.).
 *
 * Pure + client-safe — shared by the sidebar (hide nav) and the dashboard-layout
 * guard (block direct navigation) so the two can never drift apart.
 */
export function sectionForPath(pathname: string): SectionPermission | null {
  const clean = pathname.split('?')[0]
  if (ROUTE_TO_SECTION[clean]) return ROUTE_TO_SECTION[clean]
  for (const route of Object.keys(ROUTE_TO_SECTION)) {
    if (clean === route || clean.startsWith(route + '/')) return ROUTE_TO_SECTION[route]
  }
  return null
}

/** Best landing route the user can access — used for safe guard redirects. */
const LANDING_PRIORITY = ['/inbox', '/dashboard', '/reports', '/contacts', '/knowledge-base']
export function firstAccessibleRoute(perms: Set<string>): string {
  for (const route of LANDING_PRIORITY) {
    const section = ROUTE_TO_SECTION[route]
    if (!section || perms.has(section)) return route
  }
  for (const route of Object.keys(ROUTE_TO_SECTION)) {
    if (perms.has(ROUTE_TO_SECTION[route])) return route
  }
  return '/inbox'
}
