import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { validateWebhookSecret, stripHtml } from '@/lib/api-helpers'

/**
 * POST /api/webhooks/gmail-sent
 *
 * Receives sent email data from Google Apps Script.
 * Matches the thread_id to an existing conversation, creates an outbound
 * message record, and marks inbound messages as replied.
 *
 * This solves the "replied from Gmail directly" problem — the portal
 * now knows about the reply and shows it in the conversation thread.
 */
export async function POST(request: Request) {
  try {
    // Validate webhook secret
    if (!validateWebhookSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const {
      sender,
      to,
      subject,
      body: emailBody,
      thread_id,
      message_id,
      sent_at,
      from_address,
      _test,
    } = body as {
      sender: string
      to: string
      subject: string
      body: string
      thread_id: string
      message_id: string
      sent_at: string
      from_address: string
      _test?: boolean
    }

    // Handle test pings
    if (_test) {
      return NextResponse.json({ status: 'ok', message: 'Connection successful' }, { status: 200 })
    }

    if (!thread_id || !from_address) {
      return NextResponse.json(
        { error: 'Missing required fields: thread_id, from_address' },
        { status: 400 }
      )
    }

    const supabase = await createServiceRoleClient()

    // 1. Find the account by matching from_address to gmail_address
    const { data: account } = await supabase
      .from('accounts')
      .select('id, name')
      .eq('gmail_address', from_address)
      .maybeSingle()

    if (!account) {
      // Try partial match (email might have display name)
      const emailOnly = from_address.includes('<')
        ? from_address.match(/<([^>]+)>/)?.[1] || from_address
        : from_address

      const { data: accountByEmail } = await supabase
        .from('accounts')
        .select('id, name')
        .eq('gmail_address', emailOnly)
        .maybeSingle()

      if (!accountByEmail) {
        return NextResponse.json(
          { error: 'No account found for sender: ' + from_address },
          { status: 404 }
        )
      }

      // Use the matched account
      return await processReply(supabase, accountByEmail, {
        thread_id, message_id, sender, to, subject, emailBody, sent_at,
      })
    }

    return await processReply(supabase, account, {
      thread_id, message_id, sender, to, subject, emailBody, sent_at,
    })
  } catch (error) {
    console.error('Gmail sent webhook error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

async function processReply(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  account: { id: string; name: string },
  data: {
    thread_id: string
    message_id: string
    sender: string
    to: string
    subject: string
    emailBody: string
    sent_at: string
  }
) {
  const { thread_id, message_id, sender, to, subject, emailBody, sent_at } = data

  // 2. Find existing conversation by thread_id
  const { data: existingMessage } = await supabase
    .from('messages')
    .select('conversation_id')
    .eq('account_id', account.id)
    .eq('email_thread_id', thread_id)
    .limit(1)
    .maybeSingle()

  if (!existingMessage) {
    // No matching conversation found — this reply is for an email
    // we're not tracking, so skip it
    return NextResponse.json(
      { status: 'skipped', message: 'No matching conversation for thread_id' },
      { status: 200 }
    )
  }

  const conversationId = existingMessage.conversation_id

  // 3. Check if we already have this outbound message (dedup by message_id)
  if (message_id) {
    const { data: existingOutbound } = await supabase
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('direction', 'outbound')
      .eq('teams_message_id', message_id) // Reuse teams_message_id for Gmail message ID dedup
      .maybeSingle()

    if (existingOutbound) {
      return NextResponse.json(
        { status: 'duplicate', message: 'Reply already synced' },
        { status: 200 }
      )
    }
  }

  // 4. Create outbound message record so it shows in the conversation thread
  const plainText = stripHtml(emailBody || '')
  const timestamp = sent_at || new Date().toISOString()

  const { error: insertError } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    account_id: account.id,
    channel: 'email',
    sender_name: sender || account.name,
    sender_type: 'agent',
    message_text: plainText.substring(0, 50000), // Truncate if needed
    message_type: 'text',
    direction: 'outbound',
    email_subject: subject || null,
    email_thread_id: thread_id,
    teams_message_id: message_id || null, // Store Gmail message ID for dedup
    replied: true,
    reply_required: false,
    timestamp,
    received_at: timestamp,
  })

  if (insertError) {
    console.error('Failed to insert outbound message:', insertError)
    return NextResponse.json(
      { error: 'Failed to store reply: ' + insertError.message },
      { status: 500 }
    )
  }

  // 5. Mark all unreplied inbound messages in this conversation as replied
  await supabase
    .from('messages')
    .update({ replied: true })
    .eq('conversation_id', conversationId)
    .eq('direction', 'inbound')
    .eq('replied', false)

  // 6. Update conversation last_message_at and status
  await supabase
    .from('conversations')
    .update({
      last_message_at: timestamp,
      status: 'resolved',
    })
    .eq('id', conversationId)

  console.log(`Gmail reply synced: ${account.name} → thread ${thread_id}`)

  return NextResponse.json(
    {
      status: 'synced',
      message: 'Reply synced to conversation',
      conversation_id: conversationId,
      account: account.name,
    },
    { status: 201 }
  )
}
