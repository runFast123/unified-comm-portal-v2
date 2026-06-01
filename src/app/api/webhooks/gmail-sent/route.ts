import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { validateWebhookSecret, stripHtml } from '@/lib/api-helpers'
import { normalizeMessageId } from '@/lib/email-threading'

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
      rfc_message_id,
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
      /**
       * The RFC 5322 `Message-ID:` header of the sent mail. Distinct from
       * `message_id` (which is Gmail's INTERNAL id, message.getId()). This is
       * the key the IMAP Sent-folder reconcile + the partial unique index use,
       * so we dedup/store on it to collapse the two sync paths onto one row.
       * Optional for back-compat with older Apps Script deployments.
       */
      rfc_message_id?: string
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
        thread_id, message_id, rfc_message_id, sender, to, subject, emailBody, sent_at,
      })
    }

    return await processReply(supabase, account, {
      thread_id, message_id, rfc_message_id, sender, to, subject, emailBody, sent_at,
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
    rfc_message_id?: string
    sender: string
    to: string
    subject: string
    emailBody: string
    sent_at: string
  }
) {
  const { thread_id, message_id, rfc_message_id, sender, to, subject, emailBody, sent_at } = data

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

  // 3. Dedup. The SAME outbound reply can reach the portal via two paths:
  //    (a) this webhook (Gmail push → Apps Script), and
  //    (b) the IMAP Sent-folder reconcile in the poller.
  //    They MUST key on the same identifier or the reply is stored twice.
  //
  //    The canonical shared key is the RFC 5322 Message-ID — that's what the
  //    poller stores in `email_message_id` and what the partial unique index
  //    `uniq_messages_account_email_message_id (account_id, email_message_id)`
  //    enforces. The Apps Script now sends it as `rfc_message_id`. We normalize
  //    it the same way the poller does (strip angle brackets) so the values are
  //    byte-identical and converge on a single row.
  //
  //    `message_id` is Gmail's INTERNAL id (message.getId()) — a different
  //    namespace the poller never sees, so it can't dedup across paths. We keep
  //    it in `teams_message_id` only as a back-compat fallback for replies that
  //    arrive without an `rfc_message_id` (older Apps Script deployments).
  const emailMessageId = normalizeMessageId(rfc_message_id)

  if (emailMessageId) {
    // Preferred path: match the RFC Message-ID, account-scoped exactly like the
    // poller's reconcile and the unique index. A Sent-folder reconcile that
    // already stored this reply is found here, so we skip the duplicate insert.
    const { data: existingByMsgId } = await supabase
      .from('messages')
      .select('id')
      .eq('account_id', account.id)
      .eq('channel', 'email')
      .eq('email_message_id', emailMessageId)
      .limit(1)
      .maybeSingle()

    if (existingByMsgId) {
      return NextResponse.json(
        { status: 'duplicate', message: 'Reply already synced' },
        { status: 200 }
      )
    }
  } else if (message_id) {
    // Back-compat fallback (no RFC Message-ID in the payload): dedup on the
    // Gmail internal id stored in teams_message_id, scoped to this conversation.
    const { data: existingOutbound } = await supabase
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('channel', 'email')
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
    // Converge with the IMAP Sent reconcile + the partial unique index: store
    // the normalized RFC Message-ID. This is what collapses the two write paths
    // onto one row (and lets the unique index reject a concurrent duplicate).
    email_message_id: emailMessageId,
    teams_message_id: message_id || null, // Keep Gmail internal id for back-compat dedup
    replied: true,
    reply_required: false,
    timestamp,
    received_at: timestamp,
  })

  if (insertError) {
    // 23505 → the (account_id, email_message_id) unique index caught a
    // concurrent insert of this exact reply (the poller's Sent reconcile won
    // the race). Idempotent: treat as already-synced, not an error.
    if ((insertError as { code?: string }).code === '23505') {
      return NextResponse.json(
        { status: 'duplicate', message: 'Reply already synced' },
        { status: 200 }
      )
    }
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
