import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import {
  validateWebhookSecret,
  checkRateLimit,
  findOrCreateConversation,
  getAccountSettings,
} from '@/lib/api-helpers'

export async function POST(request: Request) {
  try {
    // Validate webhook secret
    if (!validateWebhookSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()

    // Accept Power Automate payload format
    const {
      account_id,
      sender_name,
      sender_email,
      message_text,
      teams_message_id,
      teams_chat_id,
      team_name,
      channel_name,
      message_type,
      timestamp,
      attachments,
      is_reply,
      parent_message_id,
    } = body

    if (!account_id) {
      return NextResponse.json(
        { error: 'Missing required field: account_id' },
        { status: 400 }
      )
    }

    // Rate limit per account
    if (!checkRateLimit(`teams_${account_id}`)) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429 }
      )
    }

    if (!sender_name) {
      return NextResponse.json(
        { error: 'Missing required field: sender_name' },
        { status: 400 }
      )
    }

    if (!message_text) {
      return NextResponse.json(
        { error: 'Missing required field: message_text' },
        { status: 400 }
      )
    }

    // Truncate message text if too large
    const MAX_MESSAGE_LENGTH = 50000 // 50KB max
    const messageText = message_text.length > MAX_MESSAGE_LENGTH
      ? message_text.substring(0, MAX_MESSAGE_LENGTH) + '... [truncated]'
      : message_text

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

    // Dedup check: skip if this teams_message_id already exists for this account
    if (teams_message_id) {
      const { data: existingMsg } = await supabase
        .from('messages')
        .select('id')
        .eq('account_id', account_id)
        .eq('teams_message_id', teams_message_id)
        .limit(1)
        .maybeSingle()

      if (existingMsg) {
        return NextResponse.json(
          { message: 'Duplicate - already processed', message_id: existingMsg.id },
          { status: 200 }
        )
      }
    }

    // Find or create conversation using teams_chat_id + sender_email for lookup
    const conversationId = await findOrCreateConversation(supabase, {
      account_id,
      channel: 'teams',
      teams_chat_id: teams_chat_id || null,
      participant_name: sender_name || null,
      participant_email: sender_email || null,
    })

    // Store metadata in attachments JSON (team_name, channel_name, parent info)
    const metadata: Record<string, unknown> = {}
    if (team_name) metadata.team_name = team_name
    if (channel_name) metadata.channel_name = channel_name
    if (is_reply) metadata.is_reply = is_reply
    if (parent_message_id) metadata.parent_message_id = parent_message_id
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      metadata.attachments = attachments
    }

    // Store message in messages table
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        account_id,
        channel: 'teams',
        teams_message_id: teams_message_id || null,
        sender_name: sender_name || null,
        sender_type: 'customer',
        message_text: messageText,
        message_type: (message_type === 'message' ? 'text' : message_type) || 'text',
        direction: 'inbound',
        attachments: Object.keys(metadata).length > 0 ? metadata : null,
        replied: false,
        reply_required: true,
        timestamp: timestamp || new Date().toISOString(),
        received_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (msgError || !message) {
      console.error('Failed to store Teams message:', msgError)
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
            channel: 'teams',
            account_id,
          }),
          signal: AbortSignal.timeout(30000),
        })
      } catch (classifyError) {
        console.error(`Phase 1 classification failed [message_id=${message.id}, account_id=${account_id}, channel=teams]:`, classifyError instanceof Error ? classifyError.message : classifyError)
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
            channel: 'teams',
            account_id,
            conversation_id: conversationId,
          }),
          signal: AbortSignal.timeout(30000),
        })
      } catch (replyError) {
        console.error(`Phase 2 AI reply generation failed [message_id=${message.id}, account_id=${account_id}, channel=teams]:`, replyError instanceof Error ? replyError.message : replyError)
      }
    }

    return NextResponse.json(
      { message_id: message.id, conversation_id: conversationId },
      { status: 201 }
    )
  } catch (error) {
    console.error('Teams webhook error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
