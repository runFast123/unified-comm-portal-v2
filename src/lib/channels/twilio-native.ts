// Native Twilio SMS inbound — validate Twilio's request signature + convert
// Twilio's FORM-ENCODED webhook params into the relay shape parseSmsInbound
// already normalizes, so native inbound (Twilio POSTing directly, NO relay)
// reuses the entire existing pipeline (account lookup → dedup → conversation →
// routing → notifications → AI dispatch).
import crypto from 'crypto'

/**
 * Validate Twilio's `X-Twilio-Signature`. Twilio computes:
 *   base64( HMAC-SHA1( authToken, fullUrl + each POST param sorted by key as key+value ) )
 * over the EXACT webhook URL it was configured with (including the query string).
 * Constant-time; false on any missing input.
 */
export function verifyTwilioSignature(
  fullUrl: string,
  params: Record<string, string>,
  signature: string | null | undefined,
  authToken: string,
): boolean {
  if (!signature || !authToken) return false
  let data = fullUrl
  for (const key of Object.keys(params).sort()) data += key + params[key]
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export interface SmsRelayShape {
  account_id: string
  sender_phone?: string
  text: string
  message_sid?: string
}

/**
 * Twilio inbound-SMS form params → relay shape. Returns null when there is no
 * Body (delivery/status callbacks carry none) — ack + ignore.
 */
export function twilioFormToRelay(params: Record<string, string>, accountId: string): SmsRelayShape | null {
  const text = params.Body ?? ''
  if (!text.trim()) return null
  return {
    account_id: accountId,
    sender_phone: params.From || undefined,
    text,
    message_sid: params.MessageSid || params.SmsSid || undefined,
  }
}
