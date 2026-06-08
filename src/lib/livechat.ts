import { createServiceRoleClient } from '@/lib/supabase-server'

/**
 * Live-chat widget shared helpers. The widget endpoints under /api/widget/* are
 * PUBLIC (the embed runs on third-party sites, the visitor has no session): they
 * authenticate the account via a public `widget_key` and scope a visitor to
 * their own thread via an unguessable `session_id` (stored in teams_chat_id).
 */

/** CORS for the public widget endpoints (the widget runs cross-origin). */
export const WIDGET_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export interface ResolvedWidget {
  account_id: string
  title: string
  color: string
  welcome_message: string
}

/** Resolve an ENABLED widget by its public key. null if missing or disabled. */
export async function resolveWidget(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  widgetKey: string
): Promise<ResolvedWidget | null> {
  const { data } = await supabase
    .from('livechat_widgets')
    .select('account_id, title, color, welcome_message, is_enabled')
    .eq('widget_key', widgetKey)
    .maybeSingle()
  const w = data as (ResolvedWidget & { is_enabled: boolean }) | null
  if (!w || !w.is_enabled) return null
  return { account_id: w.account_id, title: w.title, color: w.color, welcome_message: w.welcome_message }
}

/** A public, unguessable widget key for the embed snippet. */
export function generateWidgetKey(): string {
  return 'wk_' + crypto.randomUUID().replace(/-/g, '')
}
