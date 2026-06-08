import type { UserRole } from '@/types/database'
import { SECTION_PERMISSIONS, ACTION_PERMISSIONS, CHANNEL_PERMISSION_KEYS } from './catalog'

const ALL_SECTIONS = Object.keys(SECTION_PERMISSIONS)
const ALL_ACTIONS = Object.keys(ACTION_PERMISSIONS)

// Sections everyone sees in the nav today (Inbox / Customers / Reports groups).
// The Admin group is gated to admin roles, mirroring the current sidebar.
const NON_ADMIN_SECTIONS = [
  'section:inbox',
  'section:bookmarks',
  'section:contacts',
  'section:knowledge_base',
  'section:dashboard',
  'section:reports',
  'section:time_reports',
  'section:csat',
  'section:observability',
]

// Operational actions an agent performs today (not admin-only). Deliberately
// excludes delete / credentials.manage / users.manage / permissions.manage,
// which are admin capabilities.
const AGENT_ACTIONS = [
  'action:conversation.assign',
  'action:conversation.merge',
  'action:conversation.export',
  'action:message.send',
]

// Companies is super_admin-only today (sidebar restricts it). Company admins get
// every other section.
const ADMIN_SECTIONS_NO_COMPANIES = ALL_SECTIONS.filter((s) => s !== 'section:admin.companies')

/**
 * Code-defined baseline that MIRRORS today's hardcoded gating, so enabling RBAC
 * changes nothing until an admin customizes. DB rows in role_permissions /
 * user_permissions are SPARSE deltas applied on top of this (see resolve.ts).
 *
 * Editing these sets changes the out-of-the-box defaults for every tenant; the
 * admin UI lets each company/user deviate without touching code.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, Set<string>> = {
  // Platform owner — everything, always (also hard-guaranteed in server.ts).
  super_admin: new Set([...ALL_SECTIONS, ...ALL_ACTIONS, ...CHANNEL_PERMISSION_KEYS]),
  // Company admins — every section except the super-admin-only Companies page.
  admin: new Set([...ADMIN_SECTIONS_NO_COMPANIES, ...ALL_ACTIONS, ...CHANNEL_PERMISSION_KEYS]),
  company_admin: new Set([...ADMIN_SECTIONS_NO_COMPANIES, ...ALL_ACTIONS, ...CHANNEL_PERMISSION_KEYS]),
  // Operational roles — inbox/customers/reports + agent actions + all channels.
  // Differentiation (e.g. making viewer read-only) is left to admins via the UI,
  // so turning RBAC on is strictly non-breaking.
  supervisor: new Set([...NON_ADMIN_SECTIONS, ...AGENT_ACTIONS, ...CHANNEL_PERMISSION_KEYS]),
  company_member: new Set([...NON_ADMIN_SECTIONS, ...AGENT_ACTIONS, ...CHANNEL_PERMISSION_KEYS]),
  reviewer: new Set([...NON_ADMIN_SECTIONS, ...AGENT_ACTIONS, ...CHANNEL_PERMISSION_KEYS]),
  viewer: new Set([...NON_ADMIN_SECTIONS, ...AGENT_ACTIONS, ...CHANNEL_PERMISSION_KEYS]),
}
