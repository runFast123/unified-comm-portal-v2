import { NextResponse, after } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import {
  validateWebhookSecret,
  checkRateLimit,
  findOrCreateConversation,
  getAccountSettings,
} from '@/lib/api-helpers'
import { evaluateRouting, applyRoutingResult } from '@/lib/routing-engine'
import { z } from 'zod'
import { parseJsonBody } from '@/lib/validation'
import { parseSmsInbound } from '@/lib/channels/inbound'
import { verifyTwilioSignature, twilioFormToRelay } from '@/lib/channels/twilio-native'
import { getChannelConfig } from '@/lib/channel-config'

// Inbound SMS relay payload — a relay in front of Twilio normalizes Twilio's
// form-encoded webhook into this JSON shape and posts it here, mirroring the
// WhatsApp relay. The shared X-Webhook-Secret is the trust boundary (a direct
// Twilio post would instead be verified via X-Twilio-Signature HMAC).
const SmsInboundSchema = z.object({
  account_id: z.string().optional(),
  sender_phone: z.string().optional(),
  text: z.string().optional(),
  message_sid: z.string().optional(),
  timestamp: z.string().optional(),
})

export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    const nativeAccount = url.searchParams.get('account')
    const twilioSig = request.headers.get('x-twilio-signature')

    let account_id: string | undefined
    let sender_phone: string | undefined
    let inbound: ReturnType<typeof parseSmsInbound>

    if (nativeAccount && twilioSig) {
      // ── NATIVE Twilio webhook (no relay) ────────────────────────────────
      // Twilio POSTs form-encoded params with X-Twilio-Signature = base64 HMAC-SHA1
      // over the webhook URL + sorted params, keyed by the account's Twilio auth
      // token. Account is the ?account= we surface for the user to paste into Twilio.
      const cfg = await getChannelConfig(nativeAccount, 'sms')
      const authToken = cfg?.auth_token || process.env.TWILIO_AUTH_TOKEN || ''
      const rawBody = await request.text()
      const params: Record<string, string> = {}
      for (const [k, v] of new URLSearchParams(rawBody)) params[k] = v
      // Twilio signs over the EXACT configured URL — reconstruct proxy-safe from
      // the public host, and also try the raw request URL as a fallback.
      const proto = request.headers.get('x-forwarded-proto') || 'https'
      const host = request.headers.get('host') || url.host
      const candidates = [`${proto}://${host}${url.pathname}${url.search}`, request.url]
      const okSig = candidates.some((u) => verifyTwilioSignature(u, params, twilioSig, authToken))
      if (!okSig) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      const relay = twilioFormToRelay(params, nativeAccount)
      // Status/delivery callbacks (no Body) → ack + ignore.
      if (!relay) return NextResponse.json({ ok: true, ignored: true })
      inbound = parseSmsInbound(relay)
      account_id = nativeAccount
      sender_phone = relay.sender_phone
    } else {
      // ── Relay payload (existing path) ───────────────────────────────────
      if (!validateWebhookSecret(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      const parsed = await parseJsonBody(request, SmsInboundSchema)
      if (!parsed.ok) return parsed.response
      account_id = parsed.data.account_id
      sender_phone = parsed.data.sender_phone
      inbound = parseSmsInbound(parsed.data)
    }

    const messageText = inbound.message_text

    if (!account_id) {
      return NextResponse.json({ error: 'Missing required field: account_id' }, { status: 400 })
    }
    if (!(await checkRateLimit(`sms_${account_id}`, 100, 60))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    const supabase = await createServiceRoleClient()

    const { data: accountRow, error: accountError } = await supabase
      .from('accounts')
      .select('id, name, is_active')
      .eq('id', account_id)
      .single()
    if (accountError || !accountRow) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }
    if (!accountRow.is_active) {
      return NextResponse.json({ error: 'Account is not active' }, { status: 403 })
    }

    if (!sender_phone) {
      return NextResponse.json({ error: 'Missing required field: sender_phone' }, { status: 400 })
    }
    if (!messageText || messageText.trim().length === 0) {
      return NextResponse.json({ error: 'Empty message — nothing to process' }, { status: 400 })
    }

    // Dedup: same text from same sender within 2 minutes (mirrors WhatsApp).
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    const { data: existingMsg } = await supabase
      .from('messages')
      .select('id')
      .eq('account_id', account_id)
      .eq('channel', 'sms')
      .eq('direction', 'inbound')
      .like('sender_name', sender_phone)
      .like('message_text', messageText.substring(0, 100).replace(/%/g, '\\%').replace(/_/g, '\\_') + '%')
      .gte('timestamp', twoMinAgo)
      .limit(1)
      .maybeSingle()
    if (existingMsg) {
      return NextResponse.json(
        { message: 'Duplicate - already processed', message_id: existingMsg.id },
        { status: 200 }
      )
    }

    const conversationId = await findOrCreateConversation(supabase, {
      account_id,
      channel: 'sms',
      participant_name: sender_phone || null,
      participant_phone: sender_phone || null,
    })

    const { data: message, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        account_id,
        channel: inbound.channel,
        sender_name: inbound.sender_name,
        sender_type: inbound.sender_type,
        message_text: inbound.message_text,
        message_type: inbound.message_type,
        direction: inbound.direction,
        replied: inbound.replied,
        reply_required: inbound.reply_required,
        timestamp: inbound.timestamp || new Date().toISOString(),
        received_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (msgError || !message) {
      console.error('Failed to store SMS message:', msgError)
      return NextResponse.json({ error: 'Failed to store message' }, { status: 500 })
    }

    // Stamp the account so /admin/channels shows a current "Last synced".
    void supabase
      .from('accounts')
      .update({
        last_polled_at: new Date().toISOString(),
        consecutive_poll_failures: 0,
        last_poll_error: null,
        last_poll_error_at: null,
      })
      .eq('id', account_id)
      .then(() => undefined, () => undefined)

    // Routing rules — fail-soft.
    try {
      const routingResult = await evaluateRouting({
        channel: 'sms',
        account_id,
        sender_email: null,
        sender_phone: sender_phone || null,
        subject: null,
        message_text: messageText,
      })
      if (routingResult.matched_rule_ids.length > 0) {
        await applyRoutingResult(supabase, conversationId, routingResult)
      }
    } catch (routingErr) {
      console.error('Routing evaluation failed:', routingErr instanceof Error ? routingErr.message : routingErr)
    }

    // Notifications (async, non-blocking).
    try {
      const { triggerNotifications } = await import('@/lib/notification-service')
      triggerNotifications(supabase, {
        id: message.id,
        conversation_id: conversationId,
        account_id,
        account_name: accountRow.name || 'Unknown',
        channel: 'sms',
        sender_name: sender_phone || null,
        email_subject: null,
        message_text: messageText?.substring(0, 200) || null,
        is_spam: false,
      }).catch((err) => console.error('Notification trigger failed:', err))
    } catch (notifErr) {
      console.error('Failed to load notification service:', notifErr)
    }

    // AI dispatch — fire-and-forget via after() so the relay (and Twilio behind
    // it) gets a fast 200 instead of blocking on the AI round-trips.
    const account = await getAccountSettings(supabase, account_id)
    const origin = new URL(request.url).origin
    const headers = {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '',
    }
    if (account.phase1_enabled) {
      after(() =>
        fetch(`${origin}/api/classify`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ message_id: message.id, message_text: messageText, channel: 'sms', account_id }),
        }).then(() => undefined, () => undefined)
      )
    }
    if (account.phase2_enabled) {
      after(() =>
        fetch(`${origin}/api/ai-reply`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message_id: message.id,
            message_text: messageText,
            channel: 'sms',
            account_id,
            conversation_id: conversationId,
          }),
        }).then(() => undefined, () => undefined)
      )
    }

    return NextResponse.json({ message_id: message.id, conversation_id: conversationId }, { status: 201 })
  } catch (error) {
    console.error('SMS webhook error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
