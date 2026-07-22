import { CHANNEL_KEYS } from '@/lib/channels/registry'

/**
 * Permission catalog — the stable, code-defined set of access-control keys for
 * the RBAC layer (admin/super-admin manage who can access what from the UI).
 *
 * Key format is `<type>:<id>`. These strings are PERSISTED in role_permissions /
 * user_permissions, so never rename an existing key — add a new one + migrate.
 *
 * Models are intentionally NOT cataloged here: they come from `ai_providers` at
 * runtime and are allow-by-default with deny overrides (handled in server.ts /
 * the AI-settings wiring), since the available model list is dynamic.
 */

// ─── Sections (pages / nav items) ────────────────────────────────────────────
export const SECTION_PERMISSIONS = {
  'section:inbox': 'Inbox',
  'section:bookmarks': 'Bookmarks',
  'section:contacts': 'Contacts',
  'section:knowledge_base': 'Knowledge Base',
  'section:dashboard': 'Dashboard',
  'section:reports': 'Reports',
  'section:time_reports': 'Time Reports',
  'section:csat': 'CSAT',
  'section:observability': 'Observability',
  'section:admin.companies': 'Admin · Companies',
  'section:admin.accounts': 'Admin · Account Settings',
  'section:admin.channels': 'Admin · Channels',
  'section:admin.users': 'Admin · Users',
  'section:admin.routing': 'Admin · Routing',
  'section:admin.macros': 'Admin · Macros',
  'section:admin.templates': 'Admin · Templates',
  'section:admin.taxonomy': 'Admin · Statuses & Tags',
  'section:admin.signatures': 'Admin · Company Signatures',
  'section:admin.integrations': 'Admin · Integrations',
  'section:admin.ai_settings': 'Admin · AI Settings',
  'section:admin.notifications': 'Admin · Notifications',
  'section:admin.api_tokens': 'Admin · API Tokens',
  'section:admin.webhooks': 'Admin · Webhooks',
  'section:admin.health': 'Admin · Health',
  'section:admin.logs': 'Admin · Logs',
  'section:admin.privacy': 'Admin · Privacy & Data Requests',
  'section:admin.roles': 'Admin · Roles & Permissions',
  'section:admin.livechat': 'Admin · Live Chat',
} as const

// ─── Actions (capabilities beyond page visibility) ───────────────────────────
export const ACTION_PERMISSIONS = {
  'action:conversation.delete': 'Delete conversations',
  'action:conversation.export': 'Export conversations',
  'action:conversation.assign': 'Assign / reassign conversations',
  'action:conversation.merge': 'Merge conversations',
  // Triage = internal-only organizing (priority, tags). Split out from
  // message.send so an agent (human or AI) can be allowed to organize the inbox
  // WITHOUT being allowed to send anything to a customer. Load-bearing for the
  // AI triage agent: "can triage" must not imply "can reply".
  'action:conversation.triage': 'Triage conversations (priority, tags)',
  'action:message.send': 'Send messages / replies',
  'action:credentials.manage': 'Manage channel credentials (BYOC)',
  'action:users.manage': 'Manage users',
  'action:permissions.manage': 'Manage roles & permissions',
  'action:ai.compose': 'AI compose & autocomplete',
  'action:ai.summarize': 'AI summarize conversations',
} as const

export type SectionPermission = keyof typeof SECTION_PERMISSIONS
export type ActionPermission = keyof typeof ACTION_PERMISSIONS
export type ChannelPermission = `channel:${string}`
export type ModelPermission = `model:${string}`
export type PermissionKey = SectionPermission | ActionPermission | ChannelPermission | ModelPermission

// ─── Channels (dynamic from the channel registry) ────────────────────────────
export const CHANNEL_PERMISSION_KEYS: string[] = CHANNEL_KEYS.map((k) => `channel:${k}`)

/** Every statically-cataloged key (sections + actions + channels). */
export const ALL_CATALOG_KEYS: string[] = [
  ...Object.keys(SECTION_PERMISSIONS),
  ...Object.keys(ACTION_PERMISSIONS),
  ...CHANNEL_PERMISSION_KEYS,
]

/** Is this a key the catalog knows about (sections/actions/channels)? */
export function isKnownCatalogKey(key: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(SECTION_PERMISSIONS, key) ||
    Object.prototype.hasOwnProperty.call(ACTION_PERMISSIONS, key) ||
    CHANNEL_PERMISSION_KEYS.includes(key)
  )
}

/**
 * Dashboard route → section permission key. Drives both the sidebar (hide nav)
 * and server-side route guards (block direct navigation), so they can never
 * drift apart. Bookmarks is a view of /inbox, so it has no standalone route.
 */
export const ROUTE_TO_SECTION: Record<string, SectionPermission> = {
  '/inbox': 'section:inbox',
  '/contacts': 'section:contacts',
  '/knowledge-base': 'section:knowledge_base',
  '/dashboard': 'section:dashboard',
  '/reports': 'section:reports',
  '/admin/time-reports': 'section:time_reports',
  '/admin/csat': 'section:csat',
  '/admin/observability': 'section:observability',
  '/admin/companies': 'section:admin.companies',
  '/admin/accounts': 'section:admin.accounts',
  '/admin/channels': 'section:admin.channels',
  '/admin/users': 'section:admin.users',
  '/admin/routing': 'section:admin.routing',
  '/admin/macros': 'section:admin.macros',
  '/admin/templates': 'section:admin.templates',
  '/admin/taxonomy': 'section:admin.taxonomy',
  '/admin/company-signatures': 'section:admin.signatures',
  '/admin/integrations': 'section:admin.integrations',
  '/admin/ai-settings': 'section:admin.ai_settings',
  '/admin/notifications': 'section:admin.notifications',
  '/admin/api-tokens': 'section:admin.api_tokens',
  '/admin/webhooks': 'section:admin.webhooks',
  '/admin/health': 'section:admin.health',
  '/admin/logs': 'section:admin.logs',
  '/admin/privacy': 'section:admin.privacy',
  '/admin/roles': 'section:admin.roles',
  '/admin/livechat': 'section:admin.livechat',
}
