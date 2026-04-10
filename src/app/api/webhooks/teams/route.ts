import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { logInfo, logError } from '@/lib/logger'
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

    // Accept n8n webhook payload format
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
      is_agent_message,
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

    if (!sender_name || (typeof sender_name === 'string' && sender_name.trim().length === 0)) {
      return NextResponse.json(
        { error: 'Missing or empty required field: sender_name' },
        { status: 400 }
      )
    }

    if (!message_text || (typeof message_text === 'string' && message_text.trim().length === 0)) {
      return NextResponse.json(
        { error: 'Missing or empty required field: message_text' },
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

    // Dedup check 1: skip if this teams_message_id already exists for this account
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

    // Dedup check 2: skip if an outbound message with same text exists in same
    // conversation recently (prevents re-capturing portal-sent replies from Teams)
    if (messageText && teams_chat_id) {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      const { data: recentOutbound } = await supabase
        .from('messages')
        .select('id')
        .eq('account_id', account_id)
        .eq('direction', 'outbound')
        .like('message_text', messageText.substring(0, 100).replace(/%/g, '\\%').replace(/_/g, '\\_') + '%')
        .gte('timestamp', fiveMinAgo)
        .limit(1)
        .maybeSingle()

      if (recentOutbound) {
        return NextResponse.json(
          { message: 'Duplicate - outbound reply already recorded', message_id: recentOutbound.id },
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

    // Only store actual file attachments — NOT metadata like team_name, channel_name
    const fileAttachments = (attachments && Array.isArray(attachments) && attachments.length > 0)
      ? attachments
      : null

    // Determine if this is an agent message (company user replying in Teams)
    const isAgent = is_agent_message === true || is_agent_message === 'true'
    const senderType = isAgent ? 'agent' : 'customer'
    const direction = isAgent ? 'outbound' : 'inbound'

    // Store message in messages table
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        account_id,
        channel: 'teams',
        teams_message_id: teams_message_id || null,
        sender_name: sender_name || null,
        sender_type: senderType,
        message_text: messageText,
        message_type: (message_type === 'message' ? 'text' : message_type) || 'text',
        direction,
        attachments: fileAttachments,
        replied: isAgent ? true : false,
        reply_required: isAgent ? false : true,
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

    // Skip AI processing and notifications for agent messages
    if (isAgent) {
      // If agent message, also mark the inbound messages in this conversation as replied
      await supabase
        .from('messages')
        .update({ replied: true })
        .eq('conversation_id', conversationId)
        .eq('direction', 'inbound')
        .eq('replied', false)

      return NextResponse.json(
        { message_id: message.id, conversation_id: conversationId, is_agent: true },
        { status: 201 }
      )
    }

    // Trigger notifications for customer messages only (async, non-blocking)
    try {
      const { triggerNotifications } = await import('@/lib/notification-service')
      triggerNotifications(supabase, {
        id: message.id,
        conversation_id: conversationId,
        account_id: account_id,
        account_name: accountRow.name || 'Unknown',
        channel: 'teams',
        sender_name: sender_name || sender_email || null,
        email_subject: null,
        message_text: messageText?.substring(0, 200) || null,
        is_spam: false,
      }).catch(err => console.error('Notification trigger failed:', err))
    } catch (notifErr) {
      console.error('Failed to load notification service:', notifErr)
    }

    // Get account settings for phase flags
    const account = await getAccountSettings(supabase, account_id)
    const origin = new URL(request.url).origin
    let skipAIReply = false

    // Phase 1: AI Classification (must complete before Phase 2)
    if (account.phase1_enabled) {
      try {
        const classifyRes = await fetch(`${origin}/api/classify`, {
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

        // Check if classification marked it as Newsletter/Marketing → skip AI reply
        if (classifyRes.ok) {
          try {
            const classifyData = await classifyRes.json()
            if (classifyData.category === 'Newsletter/Marketing') {
              skipAIReply = true
            }
          } catch { /* ignore parse errors */ }
        }
      } catch (classifyError) {
        console.error(`Phase 1 classification failed [message_id=${message.id}, account_id=${account_id}, channel=teams]:`, classifyError instanceof Error ? classifyError.message : classifyError)
      }
    }

    // Phase 2: AI Reply Generation — only if not classified as spam/newsletter
    if (account.phase2_enabled && !skipAIReply) {
      try {
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

    logInfo('webhook', 'teams_received', `Teams message from ${sender_name}`, { account_id, message_id: message.id })
    return NextResponse.json(
      { message_id: message.id, conversation_id: conversationId },
      { status: 201 }
    )
  } catch (error) {
    console.error('Teams webhook error:', error)
    logError('webhook', 'teams_inbound', error instanceof Error ? error.message : 'Unknown error')
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
