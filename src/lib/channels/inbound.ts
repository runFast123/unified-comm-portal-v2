import type { ChannelType } from '@/types/database'

/**
 * Inbound normalization layer.
 *
 * Unlike the OUTBOUND side (where four send sites duplicated one dispatch and
 * collapsed cleanly into sendViaChannel), the inbound webhooks are genuinely
 * heterogeneous: Teams and WhatsApp use different dedup strategies, Teams has
 * an out-of-office auto-reply and an agent-message path WhatsApp lacks, and
 * their AI dispatch differs (Teams fires classify/reply via after(); WhatsApp
 * calls them synchronously and lets the Phase-1 result gate Phase-2). Forcing
 * all of that through one shared pipeline would produce a branch-at-every-step
 * god-function — worse than today's clean per-channel routes.
 *
 * So the part we extract is the part that is genuinely per-channel knowledge
 * AND pure: turning a provider/relay payload into a canonical InboundMessage
 * (media-fallback text, truncation, message_type mapping, which DB columns the
 * channel populates). A new channel implements ONE parser here instead of
 * re-deriving these rules inline in a webhook. The downstream pipeline (dedup,
 * findOrCreateConversation, message insert, routing, notifications, AI) stays
 * in each route, composed from the existing shared helpers.
 *
 * These functions are PURE (no I/O, no Date.now()) so they unit-test cleanly;
 * the webhook applies the timestamp fallback (`?? now()`) at insert time.
 */

/** Max stored message length before truncation (50 KB). */
export const MAX_MESSAGE_LENGTH = 50000

/**
 * Canonical inbound message — the normalized superset every channel maps onto.
 * Channel-specific identifier/content columns (teams_*, whatsapp_media_url,
 * attachments) are null for channels that don't use them. `timestamp` is the
 * provider-supplied time or null; the caller defaults null to now() at insert.
 */
export interface InboundMessage {
  channel: ChannelType
  account_id: string | null
  message_text: string
  message_type: string
  timestamp: string | null
  sender_name: string | null
  sender_email: string | null
  sender_phone: string | null
  sender_type: 'agent' | 'customer'
  direction: 'inbound' | 'outbound'
  replied: boolean
  reply_required: boolean
  teams_chat_id: string | null
  teams_message_id: string | null
  whatsapp_media_url: string | null
  attachments: unknown
}

/** Apply the shared 50 KB truncation rule. */
function truncate(text: string): string {
  if (text.length > MAX_MESSAGE_LENGTH) {
    return text.substring(0, MAX_MESSAGE_LENGTH) + '... [truncated]'
  }
  return text
}

/** Raw WhatsApp relay payload (post Zod-validation: every field optional string). */
export interface WhatsAppInboundRaw {
  account_id?: string
  sender_phone?: string
  text?: string
  media_url?: string
  message_type?: string
  timestamp?: string
}

/**
 * Normalize a WhatsApp relay payload. WhatsApp inbound is always a customer
 * message (no agent path): empty text with a media_url becomes a
 * `[Media: <type>]` placeholder so the timeline shows something, and the
 * stored message_type collapses to 'text' | 'attachment'.
 */
export function parseWhatsAppInbound(raw: WhatsAppInboundRaw): InboundMessage {
  const msgType = raw.message_type
  const mediaUrl = raw.media_url || null
  const baseText = raw.text || (mediaUrl ? `[Media: ${msgType || 'attachment'}]` : '')
  const senderPhone = raw.sender_phone || null
  return {
    channel: 'whatsapp',
    account_id: raw.account_id || null,
    message_text: truncate(baseText),
    message_type: msgType === 'text' ? 'text' : 'attachment',
    timestamp: raw.timestamp || null,
    sender_name: senderPhone,
    sender_email: null,
    sender_phone: senderPhone,
    sender_type: 'customer',
    direction: 'inbound',
    replied: false,
    reply_required: true,
    teams_chat_id: null,
    teams_message_id: null,
    whatsapp_media_url: mediaUrl,
    attachments: null,
  }
}

/** Raw Teams relay payload (fields arrive untyped from the JSON body). */
export interface TeamsInboundRaw {
  account_id?: string | null
  sender_name?: string | null
  sender_email?: string | null
  message_text?: string | null
  teams_message_id?: string | null
  teams_chat_id?: string | null
  message_type?: string | null
  timestamp?: string | null
  attachments?: unknown
  is_agent_message?: boolean | string | null
}

/**
 * Normalize a Teams relay payload. Teams (unlike WhatsApp) can carry an AGENT
 * message — a company user replying from inside Teams, flagged by
 * is_agent_message — which flips sender_type/direction/replied so the reply is
 * stored as an outbound, already-replied message. Only real file attachments
 * are kept; team_name / channel_name metadata is dropped. The `'message'`
 * provider type collapses to `'text'`.
 */
export function parseTeamsInbound(raw: TeamsInboundRaw): InboundMessage {
  const isAgent = raw.is_agent_message === true || raw.is_agent_message === 'true'
  const attachments =
    raw.attachments && Array.isArray(raw.attachments) && raw.attachments.length > 0
      ? raw.attachments
      : null
  return {
    channel: 'teams',
    account_id: raw.account_id || null,
    message_text: truncate(raw.message_text ?? ''),
    message_type: (raw.message_type === 'message' ? 'text' : raw.message_type) || 'text',
    timestamp: raw.timestamp || null,
    sender_name: raw.sender_name || null,
    sender_email: raw.sender_email || null,
    sender_phone: null,
    sender_type: isAgent ? 'agent' : 'customer',
    direction: isAgent ? 'outbound' : 'inbound',
    replied: isAgent,
    reply_required: !isAgent,
    teams_chat_id: raw.teams_chat_id || null,
    teams_message_id: raw.teams_message_id || null,
    whatsapp_media_url: null,
    attachments,
  }
}

/** Raw inbound SMS relay payload (a relay in front of Twilio posts this). */
export interface SmsInboundRaw {
  account_id?: string
  sender_phone?: string
  text?: string
  message_sid?: string
  timestamp?: string
}

/**
 * Normalize an inbound SMS. Like WhatsApp, SMS inbound is always a customer
 * message (no agent path); plain text only (MMS not handled yet), grouped by
 * the sender's phone number.
 */
export function parseSmsInbound(raw: SmsInboundRaw): InboundMessage {
  const senderPhone = raw.sender_phone || null
  return {
    channel: 'sms',
    account_id: raw.account_id || null,
    message_text: truncate(raw.text ?? ''),
    message_type: 'text',
    timestamp: raw.timestamp || null,
    sender_name: senderPhone,
    sender_email: null,
    sender_phone: senderPhone,
    sender_type: 'customer',
    direction: 'inbound',
    replied: false,
    reply_required: true,
    teams_chat_id: null,
    teams_message_id: null,
    whatsapp_media_url: null,
    attachments: null,
  }
}

/** Raw inbound Telegram relay payload (a relay normalizes Telegram's Update). */
export interface TelegramInboundRaw {
  account_id?: string
  chat_id?: string | number
  sender_name?: string
  text?: string
  message_id?: string | number
  timestamp?: string
}

/**
 * Normalize an inbound Telegram message. Telegram groups by chat id, stored in
 * the shared teams_chat_id column (accounts are single-channel). Always a
 * customer message; plain text only. message_id is kept in teams_message_id for
 * dedup.
 */
export function parseTelegramInbound(raw: TelegramInboundRaw): InboundMessage {
  const chatId = raw.chat_id != null ? String(raw.chat_id) : null
  return {
    channel: 'telegram',
    account_id: raw.account_id || null,
    message_text: truncate(raw.text ?? ''),
    message_type: 'text',
    timestamp: raw.timestamp || null,
    sender_name: raw.sender_name || chatId,
    sender_email: null,
    sender_phone: null,
    sender_type: 'customer',
    direction: 'inbound',
    replied: false,
    reply_required: true,
    teams_chat_id: chatId,
    teams_message_id: raw.message_id != null ? String(raw.message_id) : null,
    whatsapp_media_url: null,
    attachments: null,
  }
}
