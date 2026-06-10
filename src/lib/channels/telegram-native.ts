// Native Telegram inbound: convert a raw Telegram Update
// (https://core.telegram.org/bots/api#update) into the relay payload shape the
// /api/webhooks/telegram route already normalizes via parseTelegramInbound — so
// native inbound (Telegram POSTing directly, no relay) reuses the ENTIRE existing
// pipeline (dedup → conversation → routing → notifications → AI dispatch).
//
// Returns null for updates we acknowledge but ignore: non-message updates
// (joins, callbacks, my_chat_member, …) and messages with no text/caption.

export interface TelegramRelayShape {
  account_id: string
  chat_id: number
  sender_name?: string
  text: string
  message_id: number
  timestamp: string
}

export function telegramUpdateToRelay(update: unknown, accountId: string): TelegramRelayShape | null {
  if (!update || typeof update !== 'object') return null
  const u = update as Record<string, unknown>
  const m = (u.message || u.edited_message || u.channel_post) as Record<string, unknown> | undefined
  if (!m || typeof m !== 'object') return null

  const chat = m.chat as Record<string, unknown> | undefined
  if (!chat || chat.id == null) return null

  const raw = (m.text ?? m.caption ?? '') as unknown
  const text = typeof raw === 'string' ? raw : ''
  if (!text.trim()) return null // status/non-text update — ack + ignore

  const from = (m.from || {}) as Record<string, unknown>
  const first = typeof from.first_name === 'string' ? from.first_name : ''
  const last = typeof from.last_name === 'string' ? from.last_name : ''
  const username = typeof from.username === 'string' ? from.username : ''
  const title = typeof chat.title === 'string' ? chat.title : ''
  const sender = first ? `${first}${last ? ' ' + last : ''}` : username || title || undefined

  return {
    account_id: accountId,
    chat_id: Number(chat.id),
    sender_name: sender,
    text,
    message_id: Number(m.message_id),
    timestamp: m.date ? new Date(Number(m.date) * 1000).toISOString() : new Date().toISOString(),
  }
}
