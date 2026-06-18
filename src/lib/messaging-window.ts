// Meta's 24-hour customer-care window. On WhatsApp, Messenger and Instagram a
// business may send a FREEFORM reply only within 24h of the customer's last
// INBOUND message; after that a pre-approved message template (HSM) is
// required or the send is rejected. The other channels (email / teams / sms /
// telegram / livechat) have no such window.
//
// This is a pure helper so it can drive both the server-rendered header chip
// and (later) a composer warning, and be unit-tested deterministically by
// passing `now`.

export const REPLY_WINDOW_CHANNELS: ReadonlySet<string> = new Set(['whatsapp', 'messenger', 'instagram'])
export const REPLY_WINDOW_HOURS = 24

export interface ReplyWindow {
  /** Does this channel enforce a 24h freeform-reply window at all? */
  applicable: boolean
  /** Can a freeform reply be sent right now? */
  open: boolean
  /** Hours remaining before the window closes (0 when closed; null when N/A). */
  hoursLeft: number | null
}

export function computeReplyWindow(
  channel: string | null | undefined,
  lastInboundAtIso: string | null | undefined,
  now: number = Date.now()
): ReplyWindow {
  if (!channel || !REPLY_WINDOW_CHANNELS.has(channel)) {
    return { applicable: false, open: false, hoursLeft: null }
  }
  if (!lastInboundAtIso) {
    // No inbound message yet → there is no open freeform window to reply in.
    return { applicable: true, open: false, hoursLeft: 0 }
  }
  const elapsedMs = now - new Date(lastInboundAtIso).getTime()
  if (!Number.isFinite(elapsedMs)) {
    // Unparseable timestamp → fail safe to "closed" rather than claim it's open.
    return { applicable: true, open: false, hoursLeft: 0 }
  }
  const hoursLeft = REPLY_WINDOW_HOURS - elapsedMs / 3_600_000
  return { applicable: true, open: hoursLeft > 0, hoursLeft: Math.max(0, hoursLeft) }
}

/** Short human label for the window state, e.g. "6h left to reply". */
export function formatReplyWindow(w: ReplyWindow): string {
  if (!w.applicable) return ''
  if (!w.open) return 'Reply window closed'
  const h = w.hoursLeft ?? 0
  return h >= 1 ? `${Math.floor(h)}h left to reply` : '<1h left to reply'
}
