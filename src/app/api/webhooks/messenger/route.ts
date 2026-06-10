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
import { parseMessengerInbound } from '@/lib/channels/inbound'
import { verifyMetaSignature, metaMessagingEnvelopeToRelays } from '@/lib/channels/meta-native'
import { getChannelConfig } from '@/lib/channel-config'
import crypto from 'crypto'

// Inbound Messenger relay payload — a relay normalizes Meta's page webhook
// (entry[].messaging[]) into this shape and posts it here (mirrors the
// WhatsApp/Telegram relay). Trust is the shared X-Webhook-Secret (a direct Meta
// post would instead be verified via X-Hub-Signature-256 against the app secret).
const MessengerInboundSchema = z.object({
  account_id: z.string().optional(),
  sender_id: z.string().optional(),
  sender_name: z.string().optional(),
  text: z.string().optional(),
  message_id: z.string().optional(),
  timestamp: z.string().optional(),
})

// Meta webhook verification (GET hub.challenge) for NATIVE inbound. Per-account
// verify token from the config (set when the user enables inbound); env fallback.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')
  const account = searchParams.get('account')

  let verifyToken = process.env.MESSENGER_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || ''
  if (account) {
    const cfg = await getChannelConfig(account, 'messenger')
    if (cfg?.verify_token) verifyToken = cfg.verify_token
  }
  let ok = false
  if (token && verifyToken) {
    const a = Buffer.from(token, 'utf8')
    const b = Buffer.from(verifyToken, 'utf8')
    if (a.length === b.length) {
      try { ok = crypto.timingSafeEqual(a, b) } catch { ok = false }
    }
  }
  if (mode === 'subscribe' && ok) return new Response(challenge || '', { status: 200 })
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    const nativeAccount = url.searchParams.get('account')
    const metaSig = request.headers.get('x-hub-signature-256')

    let account_id: string | undefined
    let nativeMode = false
    // One delivery can carry several messages (Meta batches under load and on
    // retry) — collect them all; the relay path always yields exactly one.
    let items: Array<{ inbound: ReturnType<typeof parseMessengerInbound>; senderId?: string }> = []

    if (nativeAccount && metaSig) {
      // ── NATIVE Meta Messenger webhook (no relay) ────────────────────────
      nativeMode = true
      const cfg = await getChannelConfig(nativeAccount, 'messenger')
      const appSecret = cfg?.app_secret || process.env.MESSENGER_APP_SECRET || ''
      const rawBody = await request.text()
      if (!verifyMetaSignature(rawBody, metaSig, appSecret)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      let envelope: unknown
      try {
        envelope = JSON.parse(rawBody)
      } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
      }
      // expectedPageId scopes the shared app callback to THIS page's entries.
      const relays = metaMessagingEnvelopeToRelays(
        envelope,
        nativeAccount,
        cfg?.page_id ? String(cfg.page_id) : undefined
      )
      // Echoes / delivery receipts / other pages' entries → ack + ignore.
      if (relays.length === 0) return NextResponse.json({ ok: true, ignored: true })
      items = relays.map((r) => ({ inbound: parseMessengerInbound(r), senderId: r.sender_id }))
      account_id = nativeAccount
    } else {
      if (!validateWebhookSecret(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      const parsed = await parseJsonBody(request, MessengerInboundSchema)
      if (!parsed.ok) return parsed.response
      account_id = parsed.data.account_id
      items = [{ inbound: parseMessengerInbound(parsed.data), senderId: parsed.data.sender_id }]
    }

    if (!account_id) {
      return NextResponse.json({ error: 'Missing required field: account_id' }, { status: 400 })
    }
    if (!(await checkRateLimit(`messenger_${account_id}`, 100, 60))) {
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

    const accountSettings = await getAccountSettings(supabase, account_id)
    const origin = new URL(request.url).origin
    const aiHeaders = {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '',
    }
    const accountIdFixed = account_id

    // Per-message pipeline: dedup → conversation → store → routing →
    // notifications → AI dispatch. Returns the same response shapes the
    // single-message code used, so the relay path stays byte-compatible.
    const processOne = async (
      inbound: ReturnType<typeof parseMessengerInbound>,
      senderId: string | undefined
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      // The sender PSID lands in teams_chat_id.
      const messageText = inbound.message_text
      const psid = inbound.teams_chat_id

      if (!senderId || !psid) {
        return { status: 400, body: { error: 'Missing required field: sender_id' } }
      }
      if (!messageText || messageText.trim().length === 0) {
        return { status: 400, body: { error: 'Empty message — nothing to process' } }
      }

      // Dedup on the Messenger message id (mid) when present.
      if (inbound.teams_message_id) {
        const { data: existingMsg } = await supabase
          .from('messages')
          .select('id')
          .eq('account_id', accountIdFixed)
          .eq('channel', 'messenger')
          .eq('teams_message_id', inbound.teams_message_id)
          .limit(1)
          .maybeSingle()
        if (existingMsg) {
          return { status: 200, body: { message: 'Duplicate - already processed', message_id: existingMsg.id } }
        }
      }

      const conversationId = await findOrCreateConversation(supabase, {
        account_id: accountIdFixed,
        channel: 'messenger',
        teams_chat_id: psid,
        participant_name: inbound.sender_name,
      })

      const { data: message, error: msgError } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          account_id: accountIdFixed,
          channel: inbound.channel,
          teams_message_id: inbound.teams_message_id,
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
        console.error('Failed to store Messenger message:', msgError)
        return { status: 500, body: { error: 'Failed to store message' } }
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
        .eq('id', accountIdFixed)
        .then(() => undefined, () => undefined)

      // Routing rules — fail-soft.
      try {
        const routingResult = await evaluateRouting({
          channel: 'messenger',
          account_id: accountIdFixed,
          sender_email: null,
          sender_phone: null,
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
          account_id: accountIdFixed,
          account_name: accountRow.name || 'Unknown',
          channel: 'messenger',
          sender_name: inbound.sender_name,
          email_subject: null,
          message_text: messageText?.substring(0, 200) || null,
          is_spam: false,
        }).catch((err) => console.error('Notification trigger failed:', err))
      } catch (notifErr) {
        console.error('Failed to load notification service:', notifErr)
      }

      // AI dispatch — fire-and-forget via after() so Meta/the relay gets a fast 200.
      if (accountSettings.phase1_enabled) {
        after(() =>
          fetch(`${origin}/api/classify`, {
            method: 'POST',
            headers: aiHeaders,
            body: JSON.stringify({ message_id: message.id, message_text: messageText, channel: 'messenger', account_id: accountIdFixed }),
          }).then(() => undefined, () => undefined)
        )
      }
      if (accountSettings.phase2_enabled) {
        after(() =>
          fetch(`${origin}/api/ai-reply`, {
            method: 'POST',
            headers: aiHeaders,
            body: JSON.stringify({
              message_id: message.id,
              message_text: messageText,
              channel: 'messenger',
              account_id: accountIdFixed,
              conversation_id: conversationId,
            }),
          }).then(() => undefined, () => undefined)
        )
      }

      return { status: 201, body: { message_id: message.id, conversation_id: conversationId } }
    }

    if (!nativeMode) {
      const r = await processOne(items[0].inbound, items[0].senderId)
      return NextResponse.json(r.body, { status: r.status })
    }

    // Native batch: process every message. A hard store failure returns 500 so
    // Meta redelivers (dedup by mid absorbs the replayed successes); anything
    // else acks so webhook health stays green.
    const results: Array<{ status: number; body: Record<string, unknown> }> = []
    for (const item of items) {
      results.push(await processOne(item.inbound, item.senderId))
    }
    if (results.some((r) => r.status === 500)) {
      return NextResponse.json({ error: 'Failed to store message' }, { status: 500 })
    }
    const stored = results.filter((r) => r.status === 201)
    return NextResponse.json(
      {
        ok: true,
        processed: results.length,
        stored: stored.length,
        message_id: (stored[0]?.body as { message_id?: string } | undefined)?.message_id,
      },
      { status: stored.length > 0 ? 201 : 200 }
    )
  } catch (error) {
    console.error('Messenger webhook error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
