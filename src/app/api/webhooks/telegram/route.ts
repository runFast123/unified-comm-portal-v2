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
import { parseTelegramInbound } from '@/lib/channels/inbound'

// Inbound Telegram relay payload — a relay normalizes Telegram's Update JSON
// into this shape and posts it here (mirrors the WhatsApp/SMS relay). Trust is
// the shared X-Webhook-Secret (a direct Telegram webhook would instead set a
// secret_token via setWebhook and send it in X-Telegram-Bot-Api-Secret-Token).
const TelegramInboundSchema = z.object({
  account_id: z.string().optional(),
  chat_id: z.union([z.string(), z.number()]).optional(),
  sender_name: z.string().optional(),
  text: z.string().optional(),
  message_id: z.union([z.string(), z.number()]).optional(),
  timestamp: z.string().optional(),
})

export async function POST(request: Request) {
  try {
    if (!validateWebhookSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const parsed = await parseJsonBody(request, TelegramInboundSchema)
    if (!parsed.ok) return parsed.response
    const { account_id } = parsed.data
    // Normalize the relay payload into the canonical InboundMessage shape. The
    // Telegram chat id lands in teams_chat_id (the shared chat-id column).
    const inbound = parseTelegramInbound(parsed.data)
    const messageText = inbound.message_text
    const chatId = inbound.teams_chat_id

    if (!account_id) {
      return NextResponse.json({ error: 'Missing required field: account_id' }, { status: 400 })
    }
    if (!(await checkRateLimit(`telegram_${account_id}`, 100, 60))) {
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

    if (!chatId) {
      return NextResponse.json({ error: 'Missing required field: chat_id' }, { status: 400 })
    }
    if (!messageText || messageText.trim().length === 0) {
      return NextResponse.json({ error: 'Empty message — nothing to process' }, { status: 400 })
    }

    // Dedup on the Telegram message id (unique per chat) when present.
    if (inbound.teams_message_id) {
      const { data: existingMsg } = await supabase
        .from('messages')
        .select('id')
        .eq('account_id', account_id)
        .eq('channel', 'telegram')
        // Telegram message_id is sequential PER CHAT (resets per conversation),
        // so dedup MUST also scope by chat or distinct customers collide.
        .eq('teams_chat_id', chatId)
        .eq('teams_message_id', inbound.teams_message_id)
        .limit(1)
        .maybeSingle()
      if (existingMsg) {
        return NextResponse.json(
          { message: 'Duplicate - already processed', message_id: existingMsg.id },
          { status: 200 }
        )
      }
    }

    const conversationId = await findOrCreateConversation(supabase, {
      account_id,
      channel: 'telegram',
      teams_chat_id: chatId,
      participant_name: inbound.sender_name,
    })

    const { data: message, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        account_id,
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
      console.error('Failed to store Telegram message:', msgError)
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
        channel: 'telegram',
        account_id,
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
        account_id,
        account_name: accountRow.name || 'Unknown',
        channel: 'telegram',
        sender_name: inbound.sender_name,
        email_subject: null,
        message_text: messageText?.substring(0, 200) || null,
        is_spam: false,
      }).catch((err) => console.error('Notification trigger failed:', err))
    } catch (notifErr) {
      console.error('Failed to load notification service:', notifErr)
    }

    // AI dispatch — fire-and-forget via after() so the relay gets a fast 200.
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
          body: JSON.stringify({ message_id: message.id, message_text: messageText, channel: 'telegram', account_id }),
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
            channel: 'telegram',
            account_id,
            conversation_id: conversationId,
          }),
        }).then(() => undefined, () => undefined)
      )
    }

    return NextResponse.json({ message_id: message.id, conversation_id: conversationId }, { status: 201 })
  } catch (error) {
    console.error('Telegram webhook error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
