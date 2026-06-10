// Native Meta inbound (WhatsApp / Messenger / Instagram): verify Meta's webhook
// signature + convert Meta's native webhook ENVELOPE into the relay payload shape
// the /api/webhooks/* routes already normalize (via parseWhatsAppInbound etc.) —
// so native inbound (Meta POSTing directly, NO relay) reuses the entire existing
// pipeline (account lookup → dedup → conversation → routing → notifications → AI).
//
// Parsers return null for non-message events (delivery/read statuses, reactions)
// which the route should acknowledge with 200 and ignore.
import crypto from 'crypto'

/**
 * Verify Meta's `X-Hub-Signature-256` header — `sha256=<hex HMAC-SHA256(rawBody, appSecret)>`,
 * computed over the EXACT raw request body. Constant-time; false on any missing input.
 */
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null | undefined, appSecret: string): boolean {
  if (!signatureHeader || !appSecret) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export interface WhatsAppRelayShape {
  account_id: string
  sender_phone?: string
  text: string
  message_type?: string
  timestamp?: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * WhatsApp Cloud API webhook envelope → relay shape.
 * entry[].changes[].value.messages[] carries the message; metadata.phone_number_id
 * identifies the number (account is resolved from the URL ?account=, not here).
 */
export function whatsappEnvelopeToRelay(envelope: unknown, accountId: string): WhatsAppRelayShape | null {
  if (!envelope || typeof envelope !== 'object') return null
  const value = (envelope as any).entry?.[0]?.changes?.[0]?.value
  const msg = value?.messages?.[0]
  if (!msg) return null // statuses / non-message change → ack + ignore

  const type: string = typeof msg.type === 'string' ? msg.type : 'text'
  let text = ''
  if (type === 'text') text = msg.text?.body ?? ''
  else if (type === 'button') text = msg.button?.text ?? ''
  else if (type === 'interactive') text = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? ''
  else text = msg[type]?.caption ?? '' // image/video/document with a caption

  return {
    account_id: accountId,
    sender_phone: typeof msg.from === 'string' ? msg.from : undefined,
    text: String(text || ''),
    message_type: type === 'text' ? 'text' : type,
    timestamp: msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : undefined,
  }
}

export interface MetaMessagingRelayShape {
  account_id: string
  sender_id?: string
  text: string
  message_id?: string
  timestamp?: string
}

/**
 * Meta Messaging webhook envelope (Messenger + Instagram share it) → relay shape.
 * entry[].messaging[] carries the message; sender.id is the PSID/IGSID. Echoes of
 * our own sends (is_echo), delivery/read events, and attachment-only messages
 * return null (ack + ignore). Meta messaging timestamps are in MILLISECONDS.
 */
export function metaMessagingEnvelopeToRelay(envelope: unknown, accountId: string): MetaMessagingRelayShape | null {
  if (!envelope || typeof envelope !== 'object') return null
  const messaging = (envelope as any).entry?.[0]?.messaging?.[0]
  const message = messaging?.message
  if (!messaging || !message || message.is_echo) return null
  const raw = message.text
  const text = typeof raw === 'string' ? raw : ''
  if (!text.trim()) return null
  return {
    account_id: accountId,
    sender_id: messaging.sender?.id != null ? String(messaging.sender.id) : undefined,
    text,
    message_id: message.mid != null ? String(message.mid) : undefined,
    timestamp: messaging.timestamp ? new Date(Number(messaging.timestamp)).toISOString() : undefined,
  }
}
