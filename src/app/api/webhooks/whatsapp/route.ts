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

/**
 * GET handler for Meta webhook verification.
 * Meta sends a GET request with hub.mode, hub.verify_token, and hub.challenge.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN

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
    // Validate webhook secret
    // TODO: also verify Meta X-Hub-Signature-256 using WHATSAPP_APP_SECRET env
    if (!validateWebhookSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const {
      sender_phone,
      text,
      media_url,
      message_type: msgType,
      timestamp,
      account_id,
    } = body

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

    // Truncate message text if too large
    const MAX_MESSAGE_LENGTH = 50000 // 50KB max
    let messageText = text || (media_url ? `[Media: ${msgType || 'attachment'}]` : '')
    if (messageText.length > MAX_MESSAGE_LENGTH) {
      messageText = messageText.substring(0, MAX_MESSAGE_LENGTH) + '... [truncated]'
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

    // Validate sender_phone and message content
    if (!sender_phone) {
      return NextResponse.json(
        { error: 'Missing required field: sender_phone' },
        { status: 400 }
      )
    }
    if (!messageText || messageText.trim().length === 0) {
      return NextResponse.json(
        { error: 'Empty message — nothing to process' },
        { status: 400 }
      )
    }

    // Dedup check: skip if same text from same sender within 2 minutes
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    const { data: existingMsg } = await supabase
      .from('messages')
      .select('id')
      .eq('account_id', account_id)
      .eq('channel', 'whatsapp')
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

    // Find or create conversation
    const conversationId = await findOrCreateConversation(supabase, {
      account_id,
      channel: 'whatsapp',
      participant_name: sender_phone || null,
      participant_phone: sender_phone || null,
    })

    // Store message in messages table
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        account_id,
        channel: 'whatsapp',
        sender_name: sender_phone || null,
        sender_type: 'customer',
        message_text: messageText,
        message_type: msgType === 'text' ? 'text' : 'attachment',
        direction: 'inbound',
        whatsapp_media_url: media_url || null,
        replied: false,
        reply_required: true,
        timestamp: timestamp || new Date().toISOString(),
        received_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (msgError || !message) {
      console.error('Failed to store WhatsApp message:', msgError)
      return NextResponse.json(
        { error: 'Failed to store message' },
        { status: 500 }
      )
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
      .eq('id', account_id)
      .then(() => undefined, () => undefined)

    // Routing rules — fail-soft so the webhook never errors on rule eval.
    try {
      const routingResult = await evaluateRouting({
        channel: 'whatsapp',
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

    // Trigger notifications (async, non-blocking)
    try {
      const { triggerNotifications } = await import('@/lib/notification-service')
      triggerNotifications(supabase, {
        id: message.id,
        conversation_id: conversationId,
        account_id: account_id,
        account_name: accountRow.name || 'Unknown',
        channel: 'whatsapp',
        sender_name: sender_phone || null,
        email_subject: null,
        message_text: messageText?.substring(0, 200) || null,
        is_spam: false,
      }).catch(err => console.error('Notification trigger failed:', err))
    } catch (notifErr) {
      console.error('Failed to load notification service:', notifErr)
    }

    // Get account settings for phase flags
    const account = await getAccountSettings(supabase, account_id)

    // Phase 1: AI Classification
    let skipAIReply = false
    const origin = new URL(request.url).origin
    if (account.phase1_enabled) {
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
            account_id,
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
        console.error(`Phase 1 classification failed [message_id=${message.id}, account_id=${account_id}, channel=whatsapp]:`, classifyError instanceof Error ? classifyError.message : classifyError)
      }
    }

    // Phase 2: AI Reply Generation (skip for spam/newsletter)
    if (account.phase2_enabled && !skipAIReply) {
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
            account_id,
            conversation_id: conversationId,
          }),
          signal: AbortSignal.timeout(30000),
        })
      } catch (replyError) {
        console.error(`Phase 2 AI reply generation failed [message_id=${message.id}, account_id=${account_id}, channel=whatsapp]:`, replyError instanceof Error ? replyError.message : replyError)
      }
    }

    return NextResponse.json({ message_id: message.id }, { status: 201 })
  } catch (error) {
    console.error('WhatsApp webhook error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
