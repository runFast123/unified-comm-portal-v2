import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import {
  validateWebhookSecret,
  findOrCreateConversation,
  getAccountSettings,
  stripHtml,
  checkRateLimit,
} from '@/lib/api-helpers'

// --- Spam Detection ---

const SPAM_SENDER_PATTERNS = [
  'noreply@', 'no-reply@', 'notifications@', 'marketing@',
  'newsletter@', 'mailer-daemon@', 'postmaster@',
]

const SPAM_SUBJECT_KEYWORDS = [
  'unsubscribe', 'newsletter', 'promotional', 'advertisement',
  'do not reply', 'automated message', 'out of office', 'auto-reply',
  'delivery status notification', 'mailer-daemon',
]

const BULK_SENDER_PATTERNS = [
  'zendesk', 'freshdesk', 'hubspot', 'mailchimp',
  'sendgrid', 'constant contact', 'campaign monitor',
]

interface SpamCheckResult {
  isSpam: boolean
  reason: string | null
}

function detectSpam(
  senderEmail: string | null,
  subject: string | null,
  messageText: string
): SpamCheckResult {
  const emailLower = (senderEmail || '').toLowerCase()
  const subjectLower = (subject || '').toLowerCase()

  // 1. Known spam sender patterns
  for (const pattern of SPAM_SENDER_PATTERNS) {
    if (emailLower.startsWith(pattern)) {
      return { isSpam: true, reason: `Automated sender: ${pattern.replace('@', '')}` }
    }
  }

  // 2. Spam keywords in subject
  for (const keyword of SPAM_SUBJECT_KEYWORDS) {
    if (subjectLower.includes(keyword)) {
      return { isSpam: true, reason: `Spam keyword in subject: ${keyword}` }
    }
  }

  // 3. Bulk sender patterns
  for (const pattern of BULK_SENDER_PATTERNS) {
    if (emailLower.includes(pattern)) {
      return { isSpam: true, reason: `Bulk sender: ${pattern}` }
    }
  }

  // 4. Empty or very short messages
  if (!messageText || messageText.trim().length < 10) {
    return { isSpam: true, reason: 'Empty or very short message' }
  }

  return { isSpam: false, reason: null }
}

export async function POST(request: Request) {
  try {
    // Validate webhook secret
    if (!validateWebhookSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { sender, subject, body: emailBody, thread_id, account_id, attachments } = body

    // Parse RFC 5322 format: "Display Name" <email@addr> or just email@addr
    const emailMatch = sender ? sender.match(/<([^>]+)>/) : null
    const senderEmail = emailMatch ? emailMatch[1].trim() : (sender || null)
    const senderName = emailMatch
      ? sender.slice(0, sender.indexOf('<')).trim().replace(/^["']|["']$/g, '') || senderEmail
      : sender || null

    if (!account_id) {
      return NextResponse.json(
        { error: 'Missing required field: account_id' },
        { status: 400 }
      )
    }

    // Rate limit per account
    if (!checkRateLimit(`webhook:email:${account_id}`)) {
      return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 })
    }

    if (!sender || (typeof sender === 'string' && sender.trim().length === 0)) {
      return NextResponse.json(
        { error: 'Missing or empty required field: sender' },
        { status: 400 }
      )
    }

    // Strip HTML from email body and truncate if too large
    const MAX_MESSAGE_LENGTH = 50000 // 50KB max
    let plainTextBody = emailBody ? stripHtml(emailBody) : ''
    if (plainTextBody.length > MAX_MESSAGE_LENGTH) {
      plainTextBody = plainTextBody.substring(0, MAX_MESSAGE_LENGTH) + '... [truncated]'
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

    // Dedup check: skip if this thread_id already exists for this account
    if (thread_id) {
      const { data: existingMsg } = await supabase
        .from('messages')
        .select('id')
        .eq('account_id', account_id)
        .eq('email_thread_id', thread_id)
        .limit(1)
        .maybeSingle()

      if (existingMsg) {
        return NextResponse.json(
          { message: 'Duplicate - already processed', message_id: existingMsg.id },
          { status: 200 }
        )
      }
    }

    // Spam detection — run before storing
    const spamResult = detectSpam(senderEmail, subject, plainTextBody)

    // Find or create conversation
    const conversationId = await findOrCreateConversation(supabase, {
      account_id,
      channel: 'email',
      participant_name: senderName,
      participant_email: senderEmail,
    })

    // Store message in messages table (spam is stored but flagged)
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        account_id,
        channel: 'email',
        sender_name: sender || null,
        sender_type: 'customer',
        message_text: plainTextBody,
        message_type: 'text',
        direction: 'inbound',
        email_subject: subject || null,
        email_thread_id: thread_id || null,
        attachments: attachments || null,
        replied: false,
        reply_required: spamResult.isSpam ? false : true,
        is_spam: spamResult.isSpam,
        spam_reason: spamResult.reason,
        timestamp: new Date().toISOString(),
        received_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (msgError || !message) {
      console.error('Failed to store email message:', msgError)
      return NextResponse.json(
        { error: 'Failed to store message' },
        { status: 500 }
      )
    }

    // Skip AI processing for spam messages (save costs)
    if (!spamResult.isSpam) {
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
              message_text: plainTextBody,
              channel: 'email',
              account_id,
            }),
            signal: AbortSignal.timeout(30000),
          })
        } catch (classifyError) {
          console.error(`Phase 1 classification failed [message_id=${message.id}, account_id=${account_id}, channel=email]:`, classifyError instanceof Error ? classifyError.message : classifyError)
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
              message_text: plainTextBody,
              channel: 'email',
              account_id,
              conversation_id: conversationId,
            }),
            signal: AbortSignal.timeout(30000),
          })
        } catch (replyError) {
          console.error(`Phase 2 AI reply generation failed [message_id=${message.id}, account_id=${account_id}, channel=email]:`, replyError instanceof Error ? replyError.message : replyError)
        }
      }
    }

    return NextResponse.json(
      { message_id: message.id, is_spam: spamResult.isSpam },
      { status: 201 }
    )
  } catch (error) {
    console.error('Email webhook error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
