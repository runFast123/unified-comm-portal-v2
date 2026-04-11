import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { validateWebhookSecret, checkRateLimit } from '@/lib/api-helpers'

export async function POST(request: Request) {
  try {
    // Validate webhook secret
    if (!validateWebhookSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { conversation_id, reply_text, account_id } = body

    if (!conversation_id) {
      return NextResponse.json(
        { error: 'Missing required field: conversation_id' },
        { status: 400 }
      )
    }

    if (!reply_text) {
      return NextResponse.json(
        { error: 'Missing required field: reply_text' },
        { status: 400 }
      )
    }

    if (!account_id) {
      return NextResponse.json(
        { error: 'Missing required field: account_id' },
        { status: 400 }
      )
    }

    // Rate limit per account
    if (!checkRateLimit(`teams-reply:${account_id}`)) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    const supabase = await createServiceRoleClient()

    // Look up the conversation to get teams_chat_id and metadata
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, teams_chat_id, account_id, channel')
      .eq('id', conversation_id)
      .eq('account_id', account_id)
      .single()

    if (convError || !conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    if (conversation.channel !== 'teams') {
      return NextResponse.json(
        { error: 'Conversation is not a Teams channel' },
        { status: 400 }
      )
    }

    // Get the latest inbound message to extract team_name and channel_name from metadata
    const { data: latestMessage } = await supabase
      .from('messages')
      .select('attachments')
      .eq('conversation_id', conversation_id)
      .eq('direction', 'inbound')
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle()

    const metadata = (latestMessage?.attachments as Record<string, unknown>) || {}
    const teamName = (metadata.team_name as string) || null
    const channelName = (metadata.channel_name as string) || null

    // Check if outbound message already exists (created by conversation-actions)
    const { data: existingOutbound } = await supabase
      .from('messages')
      .select('id')
      .eq('conversation_id', conversation_id)
      .eq('direction', 'outbound')
      .like('message_text', reply_text.substring(0, 100).replace(/%/g, '\\%').replace(/_/g, '\\_') + '%')
      .gte('timestamp', new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .limit(1)
      .maybeSingle()

    let replyMessageId = existingOutbound?.id

    // Only create if not already exists
    if (!existingOutbound) {
      const { data: replyMessage, error: replyError } = await supabase
        .from('messages')
        .insert({
          conversation_id,
          account_id,
          channel: 'teams',
          sender_name: 'Agent',
          sender_type: 'agent',
          message_text: reply_text,
          message_type: 'text',
          direction: 'outbound',
          replied: true,
          reply_required: false,
          timestamp: new Date().toISOString(),
          received_at: new Date().toISOString(),
        })
        .select('id')
        .single()

      if (replyError || !replyMessage) {
        console.error('Failed to store Teams reply message:', replyError)
        return NextResponse.json(
          { error: 'Failed to store reply message' },
          { status: 500 }
        )
      }
      replyMessageId = replyMessage.id
    }

    // Mark any pending AI replies for this conversation as sent
    await supabase
      .from('ai_replies')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        delivery_status: 'sent_via_n8n',
      })
      .eq('conversation_id', conversation_id)
      .eq('account_id', account_id)
      .eq('status', 'approved')

    // Mark the original inbound message(s) as replied
    await supabase
      .from('messages')
      .update({ replied: true })
      .eq('conversation_id', conversation_id)
      .eq('direction', 'inbound')
      .eq('replied', false)

    // Return reply details for n8n to consume
    return NextResponse.json({
      success: true,
      reply_text,
      teams_chat_id: conversation.teams_chat_id,
      team_name: teamName,
      channel_name: channelName,
      message_id: replyMessageId,
      conversation_id,
    })
  } catch (error) {
    console.error('Teams reply error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
