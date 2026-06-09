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

export interface BusinessHours {
  tz: string
  days: string[] // subset of mon,tue,wed,thu,fri,sat,sun
  open: string // 'HH:MM'
  close: string // 'HH:MM'
}

/**
 * Is the widget within its business hours right now? Computed SERVER-SIDE (via
 * Intl with the configured timezone) so the visitor's own clock never matters.
 * Handles overnight windows (close <= open). Fails OPEN (returns online=true) on
 * any bad input so a misconfiguration never blocks chat.
 */
export function isWidgetOnline(enabled: boolean, bh: BusinessHours | null | undefined): boolean {
  if (!enabled || !bh || !Array.isArray(bh.days) || !bh.open || !bh.close) return true
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: bh.tz || 'UTC',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date())
    const wd = (parts.find((p) => p.type === 'weekday')?.value || '').toLowerCase().slice(0, 3)
    const hh = Number(parts.find((p) => p.type === 'hour')?.value || '0') % 24
    const mm = Number(parts.find((p) => p.type === 'minute')?.value || '0')
    if (!bh.days.includes(wd)) return false
    const cur = hh * 60 + mm
    const [oh, om] = bh.open.split(':').map(Number)
    const [ch, cm] = bh.close.split(':').map(Number)
    const o = oh * 60 + om
    const c = ch * 60 + cm
    if (c <= o) return cur >= o || cur < c // overnight window (e.g. 22:00–02:00)
    return cur >= o && cur < c
  } catch {
    return true
  }
}

export interface ResolvedWidget {
  account_id: string
  title: string
  color: string
  welcome_message: string
  subtitle: string
  launcher_text: string
  position: string
  prechat_enabled: boolean
  business_hours_enabled: boolean
  business_hours: BusinessHours | null
  offline_message: string
}

/** Resolve an ENABLED widget by its public key. null if missing or disabled. */
export async function resolveWidget(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  widgetKey: string
): Promise<ResolvedWidget | null> {
  const { data } = await supabase
    .from('livechat_widgets')
    .select('account_id, title, color, welcome_message, subtitle, launcher_text, position, prechat_enabled, business_hours_enabled, business_hours, offline_message, is_enabled')
    .eq('widget_key', widgetKey)
    .maybeSingle()
  const w = data as (ResolvedWidget & { is_enabled: boolean }) | null
  if (!w || !w.is_enabled) return null
  return {
    account_id: w.account_id,
    title: w.title,
    color: w.color,
    welcome_message: w.welcome_message,
    subtitle: w.subtitle ?? '',
    launcher_text: w.launcher_text ?? '',
    position: w.position === 'left' ? 'left' : 'right',
    prechat_enabled: !!w.prechat_enabled,
    business_hours_enabled: !!w.business_hours_enabled,
    business_hours: (w.business_hours as BusinessHours | null) ?? null,
    offline_message: w.offline_message ?? '',
  }
}

/** A public, unguessable widget key for the embed snippet. */
export function generateWidgetKey(): string {
  return 'wk_' + crypto.randomUUID().replace(/-/g, '')
}
