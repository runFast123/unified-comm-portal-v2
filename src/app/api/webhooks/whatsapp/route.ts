import crypto from 'crypto'
import { NextResponse } from 'next/server'
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
import { parseWhatsAppInbound } from '@/lib/channels/inbound'
import { verifyMetaSignature, whatsappEnvelopeToRelays } from '@/lib/channels/meta-native'
import { getChannelConfig } from '@/lib/channel-config'

// Inbound relay payload (custom shape — NOT Meta's envelope; see POST below).
// Every field is a string; we type-validate them here and keep the business
// rules (account_id / sender_phone present, message non-empty) in the handler.
const WhatsAppInboundSchema = z.object({
  account_id: z.string().optional(),
  sender_phone: z.string().optional(),
  text: z.string().optional(),
  media_url: z.string().optional(),
  message_type: z.string().optional(),
  timestamp: z.string().optional(),
})

/**
 * GET handler for Meta webhook verification.
 * Meta sends a GET request with hub.mode, hub.verify_token, and hub.challenge.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')
  const account = searchParams.get('account')

  // Per-account verify token (set in the WhatsApp config) so each Meta number can
  // use its own; falls back to the platform env for the legacy single-app setup.
  let verifyToken = process.env.WHATSAPP_VERIFY_TOKEN
  if (account) {
    const cfg = await getChannelConfig(account, 'whatsapp')
    if (cfg?.verify_token) verifyToken = cfg.verify_token
  }

  // Timing-safe token comparison to prevent timing attacks
  let tokenValid = false
  if (token && verifyToken) {
    try {
      const tokenBuf = Buffer.from(token, 'utf8')
      const verifyBuf = Buffer.from(verifyToken, 'utf8')
      if (tokenBuf.length === verifyBuf.length) {
        tokenValid = crypto.timingSafeEqual(tokenBuf, verifyBuf)
      }
    } catch {
      tokenValid = false
    }
  }

  if (mode === 'subscribe' && tokenValid) {
    return new Response(challenge || '', { status: 200 })
  }

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
    let items: Array<{ inbound: ReturnType<typeof parseWhatsAppInbound>; senderPhone?: string }> = []

    if (nativeAccount && metaSig) {
      // ── NATIVE Meta WhatsApp webhook (no relay) ─────────────────────────
      // Meta POSTs its envelope directly here. Auth = HMAC-SHA256 of the RAW body
      // against the account's Meta App Secret (X-Hub-Signature-256). The account
      // is the ?account= we surface for the user to paste into Meta's webhook.
      nativeMode = true
      const cfg = await getChannelConfig(nativeAccount, 'whatsapp')
      const appSecret = cfg?.app_secret || process.env.WHATSAPP_APP_SECRET || ''
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
      // expectedPhoneNumberId scopes the shared app callback to THIS number's
      // deliveries — other numbers under the same Meta app are acked + ignored.
      const relays = whatsappEnvelopeToRelays(
        envelope,
        nativeAccount,
        cfg?.phone_number_id ? String(cfg.phone_number_id) : undefined
      )
      // Status/read receipts + non-message events → ack + ignore.
      if (relays.length === 0) return NextResponse.json({ ok: true, ignored: true })
      items = relays.map((r) => ({ inbound: parseWhatsAppInbound(r), senderPhone: r.sender_phone }))
      account_id = nativeAccount
    } else {
      // ── Relay payload (existing path) ───────────────────────────────────
      // CUSTOM relay payload ({ sender_phone, text, account_id, … }), trusted via
      // the shared X-Webhook-Secret.
      if (!validateWebhookSecret(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      const parsed = await parseJsonBody(request, WhatsAppInboundSchema)
      if (!parsed.ok) return parsed.response
      account_id = parsed.data.account_id
      items = [{ inbound: parseWhatsAppInbound(parsed.data), senderPhone: parsed.data.sender_phone }]
    }

    if (!account_id) {
      return NextResponse.json(
        { error: 'Missing required field: account_id' },
        { status: 400 }
      )
    }

    // Rate limit per account
    if (!(await checkRateLimit(`whatsapp_${account_id}`, 100, 60))) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429 }
      )
    }

    const supabase = await createServiceRoleClient()

    // Verify account exists and is active
    const { data: accountRow, error: accountError } = await supabase
      .from('accounts')
      .select('id, name, is_active')
      .eq('id', account_id)
      .single()

    if (accountError || !accountRow) {
      return NextResponse.json(
        { error: 'Account not found' },
        { status: 404 }
      )
    }

    if (!accountRow.is_active) {
      return NextResponse.json(
        { error: 'Account is not active' },
        { status: 403 }
      )
    }

    // Account settings (phase flags) — fetched once for the whole delivery.
    const accountSettings = await getAccountSettings(supabase, account_id)
    const origin = new URL(request.url).origin
    const accountIdFixed = account_id

    // Per-message pipeline: dedup → conversation → store → routing →
    // notifications → AI. Returns the same response shapes the
    // single-message code used, so the relay path stays byte-compatible.
    const processOne = async (
      inbound: ReturnType<typeof parseWhatsAppInbound>,
      senderPhone: string | undefined
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      // Normalized, truncated message text (see parseWhatsAppInbound).
      const messageText = inbound.message_text

      if (!senderPhone) {
        return { status: 400, body: { error: 'Missing required field: sender_phone' } }
      }
      if (!messageText || messageText.trim().length === 0) {
        return { status: 400, body: { error: 'Empty message — nothing to process' } }
      }

      // Dedup check: skip if same text from same sender within 2 minutes
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()
      const { data: existingMsg } = await supabase
        .from('messages')
        .select('id')
        .eq('account_id', accountIdFixed)
        .eq('channel', 'whatsapp')
        .eq('direction', 'inbound')
        .like('sender_name', senderPhone)
        .like('message_text', messageText.substring(0, 100).replace(/%/g, '\\%').replace(/_/g, '\\_') + '%')
        .gte('timestamp', twoMinAgo)
        .limit(1)
        .maybeSingle()

      if (existingMsg) {
        return { status: 200, body: { message: 'Duplicate - already processed', message_id: existingMsg.id } }
      }

      // Find or create conversation
      const conversationId = await findOrCreateConversation(supabase, {
        account_id: accountIdFixed,
        channel: 'whatsapp',
        participant_name: senderPhone || null,
        participant_phone: senderPhone || null,
      })

      // Store message in messages table
      const { data: message, error: msgError } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          account_id: accountIdFixed,
          channel: inbound.channel,
          sender_name: inbound.sender_name,
          sender_type: inbound.sender_type,
          message_text: inbound.message_text,
          message_type: inbound.message_type,
          direction: inbound.direction,
          whatsapp_media_url: inbound.whatsapp_media_url,
          replied: inbound.replied,
          reply_required: inbound.reply_required,
          timestamp: inbound.timestamp || new Date().toISOString(),
          received_at: new Date().toISOString(),
        })
        .select('id')
        .single()

      if (msgError || !message) {
        console.error('Failed to store WhatsApp message:', msgError)
        return { status: 500, body: { error: 'Failed to store message' } }
      }

      // Stamp the account so /admin/channels shows a current "Last synced"
      // even when WhatsApp messages arrive via the webhook rather than the
      // polling cron. Fire-and-forget; mirrors email + teams. Never blocks.
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

      // Routing rules — fail-soft so the webhook never errors on rule eval.
      try {
        const routingResult = await evaluateRouting({
          channel: 'whatsapp',
          account_id: accountIdFixed,
          sender_email: null,
          sender_phone: senderPhone || null,
          subject: null,
          message_text: messageText,
        })
        if (routingResult.matched_rule_ids.length > 0) {
          await applyRoutingResult(supabase, conversationId, routingResult)
        }
      } catch (routingErr) {
        console.error('Routing evaluation failed:', routingErr instanceof Error ? routingErr.message : routingErr)
      }

      // Trigger notifications (async, non-blocking)
      try {
        const { triggerNotifications } = await import('@/lib/notification-service')
        triggerNotifications(supabase, {
          id: message.id,
          conversation_id: conversationId,
          account_id: accountIdFixed,
          account_name: accountRow.name || 'Unknown',
          channel: 'whatsapp',
          sender_name: senderPhone || null,
          email_subject: null,
          message_text: messageText?.substring(0, 200) || null,
          is_spam: false,
        }).catch(err => console.error('Notification trigger failed:', err))
      } catch (notifErr) {
        console.error('Failed to load notification service:', notifErr)
      }

      // Phase 1: AI Classification
      let skipAIReply = false
      if (accountSettings.phase1_enabled) {
        try {
          const classifyRes = await fetch(`${origin}/api/classify`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '',
            },
            body: JSON.stringify({
              message_id: message.id,
              message_text: messageText,
              channel: 'whatsapp',
              account_id: accountIdFixed,
            }),
            signal: AbortSignal.timeout(30000),
          })
          // Check if classified as spam/newsletter → skip Phase 2
          if (classifyRes.ok) {
            try {
              const classifyData = await classifyRes.json()
              if (classifyData?.category === 'Newsletter/Marketing' || classifyData?.is_spam) {
                skipAIReply = true
              }
            } catch { /* ignore parse error */ }
          }
        } catch (classifyError) {
          console.error(`Phase 1 classification failed [message_id=${message.id}, account_id=${accountIdFixed}, channel=whatsapp]:`, classifyError instanceof Error ? classifyError.message : classifyError)
        }
      }

      // Phase 2: AI Reply Generation (skip for spam/newsletter)
      if (accountSettings.phase2_enabled && !skipAIReply) {
        try {
          await fetch(`${origin}/api/ai-reply`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '',
            },
            body: JSON.stringify({
              message_id: message.id,
              message_text: messageText,
              channel: 'whatsapp',
              account_id: accountIdFixed,
              conversation_id: conversationId,
            }),
            signal: AbortSignal.timeout(30000),
          })
        } catch (replyError) {
          console.error(`Phase 2 AI reply generation failed [message_id=${message.id}, account_id=${accountIdFixed}, channel=whatsapp]:`, replyError instanceof Error ? replyError.message : replyError)
        }
      }

      return { status: 201, body: { message_id: message.id } }
    }

    if (!nativeMode) {
      const r = await processOne(items[0].inbound, items[0].senderPhone)
      return NextResponse.json(r.body, { status: r.status })
    }

    // Native batch: process every message. A hard store failure returns 500 so
    // Meta redelivers (the 2-minute text dedup absorbs the replayed successes);
    // anything else acks so webhook health stays green.
    const results: Array<{ status: number; body: Record<string, unknown> }> = []
    for (const item of items) {
      results.push(await processOne(item.inbound, item.senderPhone))
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
    console.error('WhatsApp webhook error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
