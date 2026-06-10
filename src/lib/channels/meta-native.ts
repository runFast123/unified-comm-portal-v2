// Native Meta inbound (WhatsApp / Messenger / Instagram): verify Meta's webhook
// signature + convert Meta's native webhook ENVELOPE into the relay payload shape
// the /api/webhooks/* routes already normalize (via parseWhatsAppInbound etc.) —
// so native inbound (Meta POSTing directly, NO relay) reuses the entire existing
// pipeline (account lookup → dedup → conversation → routing → notifications → AI).
//
// Parsers return ARRAYS: Meta batches webhook deliveries (multiple entry items,
// multiple changes, multiple messages per value — especially under load and on
// retry after downtime), so reading only entry[0] would silently drop the rest.
// Non-message events (delivery/read statuses, reactions, echoes) are skipped;
// an empty array means the route should acknowledge with 200 and ignore.
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

// Media types that represent real customer content. A caption-less photo or
// voice note must still land in the inbox (as a placeholder) — returning
// nothing would make the route 400 back to Meta and silently drop it.
const WA_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker', 'voice'])

function whatsappMessageToRelay(msg: any, accountId: string): WhatsAppRelayShape | null {
  if (!msg || typeof msg !== 'object') return null
  const type: string = typeof msg.type === 'string' ? msg.type : 'text'
  let text = ''
  if (type === 'text') text = msg.text?.body ?? ''
  else if (type === 'button') text = msg.button?.text ?? ''
  else if (type === 'interactive') text = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? ''
  else text = msg[type]?.caption ?? '' // image/video/document with a caption
  if (!String(text).trim() && WA_MEDIA_TYPES.has(type)) text = `[${type}]`
  if (!String(text).trim()) return null // reactions / unknown types → skip

  return {
    account_id: accountId,
    sender_phone: typeof msg.from === 'string' ? msg.from : undefined,
    text: String(text),
    message_type: type === 'text' ? 'text' : type,
    timestamp: msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : undefined,
  }
}

/**
 * WhatsApp Cloud API webhook envelope → relay shapes (ALL batched messages).
 * entry[].changes[].value.messages[] carries the messages.
 *
 * `expectedPhoneNumberId`: a Meta app has ONE callback URL, so when several
 * WhatsApp numbers live under the same app, deliveries for OTHER numbers hit
 * this account's URL too. When provided, changes whose
 * value.metadata.phone_number_id doesn't match are skipped (acked upstream) —
 * otherwise messages would be stored under the wrong account.
 */
export function whatsappEnvelopeToRelays(envelope: unknown, accountId: string, expectedPhoneNumberId?: string): WhatsAppRelayShape[] {
  if (!envelope || typeof envelope !== 'object') return []
  const out: WhatsAppRelayShape[] = []
  const entries = Array.isArray((envelope as any).entry) ? (envelope as any).entry : []
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : []
    for (const change of changes) {
      const value = change?.value
      const targetId = value?.metadata?.phone_number_id
      if (expectedPhoneNumberId && targetId != null && String(targetId) !== expectedPhoneNumberId) continue
      const msgs = Array.isArray(value?.messages) ? value.messages : []
      for (const msg of msgs) {
        const r = whatsappMessageToRelay(msg, accountId)
        if (r) out.push(r)
      }
    }
  }
  return out
}

export interface MetaMessagingRelayShape {
  account_id: string
  sender_id?: string
  text: string
  message_id?: string
  timestamp?: string
}

function metaMessagingItemToRelay(messaging: any, accountId: string): MetaMessagingRelayShape | null {
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

/**
 * Meta Messaging webhook envelope (Messenger + Instagram share it) → relay
 * shapes (ALL batched messages). entry[].messaging[] carries the messages;
 * sender.id is the PSID/IGSID. Echoes of our own sends (is_echo),
 * delivery/read events, and attachment-only messages are skipped.
 * Meta messaging timestamps are in MILLISECONDS.
 *
 * `expectedPageId` (MESSENGER ONLY): entry.id is the Facebook Page id, so when
 * several Pages share one Meta app (one callback URL), entries for other Pages
 * are skipped instead of being misattributed to this account. Do NOT pass it
 * for Instagram — there entry.id is the IG professional-account id, which is
 * NOT the linked Facebook Page id we store, so filtering would drop real
 * messages.
 */
export function metaMessagingEnvelopeToRelays(envelope: unknown, accountId: string, expectedPageId?: string): MetaMessagingRelayShape[] {
  if (!envelope || typeof envelope !== 'object') return []
  const out: MetaMessagingRelayShape[] = []
  const entries = Array.isArray((envelope as any).entry) ? (envelope as any).entry : []
  for (const entry of entries) {
    if (expectedPageId && entry?.id != null && String(entry.id) !== expectedPageId) continue
    const messaging = Array.isArray(entry?.messaging) ? entry.messaging : []
    for (const item of messaging) {
      const r = metaMessagingItemToRelay(item, accountId)
      if (r) out.push(r)
    }
  }
  return out
}
