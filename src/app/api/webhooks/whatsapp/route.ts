import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import {
  validateWebhookSecret,
  checkRateLimit,
  findOrCreateConversation,
  getAccountSettings,
} from '@/lib/api-helpers'

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
    if (!checkRateLimit(`whatsapp_${account_id}`)) {
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
      .select('id, is_active')
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

    // Get account settings for phase flags
    const account = await getAccountSettings(supabase, account_id)

    // Phase 1: AI Classification
    if (account.phase1_enabled) {
      try {
        const origin = new URL(request.url).origin
        await fetch(`${origin}/api/classify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': process.env.N8N_WEBHOOK_SECRET || '',
          },
          body: JSON.stringify({
            message_id: message.id,
            message_text: messageText,
            channel: 'whatsapp',
            account_id,
          }),
          signal: AbortSignal.timeout(30000),
        })
      } catch (classifyError) {
        console.error(`Phase 1 classification failed [message_id=${message.id}, account_id=${account_id}, channel=whatsapp]:`, classifyError instanceof Error ? classifyError.message : classifyError)
      }
    }

    // Phase 2: AI Reply Generation
    if (account.phase2_enabled) {
      try {
        const origin = new URL(request.url).origin
        await fetch(`${origin}/api/ai-reply`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': process.env.N8N_WEBHOOK_SECRET || '',
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
