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
  'digest@', 'updates@', 'news@', 'alerts@', 'promo@',
  'campaigns@', 'bounce@', 'auto@', 'system@', 'donotreply@',
  'unsubscribe@', 'feedback@', 'survey@', 'invite@',
]

const SPAM_SUBJECT_KEYWORDS = [
  'unsubscribe', 'newsletter', 'promotional', 'advertisement',
  'do not reply', 'automated message', 'out of office', 'auto-reply',
  'delivery status notification', 'mailer-daemon',
]

const NEWSLETTER_SUBJECT_KEYWORDS = [
  'webinar', 'invitation to', 'register now', 'sign up today',
  'event reminder', 'join us', 'you\'re invited',
  'digest', 'roundup', 'weekly update', 'monthly update', 'daily update',
  'what\'s new', 'product update', 'release notes', 'changelog',
  'award', 'nomination', 'submit your entry',
  'survey', 'take our survey', 'your feedback',
  'received $', 'payment of $', 'transaction alert',
  'account statement', 'billing summary',
  'trending', 'top stories', 'breaking news',
  'limited time', 'exclusive offer', 'special deal', 'save up to',
  'free trial', 'get started free',
]

const BULK_SENDER_PATTERNS = [
  'zendesk', 'freshdesk', 'hubspot', 'mailchimp',
  'sendgrid', 'constant contact', 'campaign monitor',
  'mailgun', 'postmark', 'sparkpost', 'sendinblue', 'brevo',
  'convertkit', 'drip', 'activecampaign', 'klaviyo',
  'intercom', 'drift', 'crisp', 'tawk',
]

const NEWSLETTER_SENDER_DOMAINS = [
  'mailchimp.com', 'sendgrid.net', 'hubspot.com', 'constantcontact.com',
  'campaign-archive.com', 'createsend.com', 'mailgun.org',
  'email.mg.', 'mail.', 'em.', 'e.', 'news.',
  'microsoft.com', 'linkedin.com', 'quora.com', 'facebook.com',
  'mercury.com', 'stripe.com', 'paypal.com', 'square.com',
  'zoom.us', 'calendly.com', 'eventbrite.com', 'meetup.com',
  'substack.com', 'medium.com', 'ghost.io',
  'google.com', 'apple.com', 'amazon.com',
  'notion.so', 'slack.com', 'atlassian.com', 'jira.com',
  'github.com', 'gitlab.com', 'bitbucket.org',
  'canva.com', 'figma.com', 'grammarly.com',
  'juniperresearch.com', 'nice.com', 'abundantiot.com',
  'lineleader.com', 'textus.com', 'ivoipe.com',
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
  const bodyLower = messageText.toLowerCase()

  // 1. Check hard spam sender patterns
  if (SPAM_SENDER_PATTERNS.some(p => emailLower.startsWith(p))) {
    return { isSpam: true, reason: 'automated_notification' }
  }

  // 2. Check hard spam subject keywords
  if (SPAM_SUBJECT_KEYWORDS.some(kw => subjectLower.includes(kw))) {
    return { isSpam: true, reason: 'spam' }
  }

  // 3. Check newsletter sender domains
  if (NEWSLETTER_SENDER_DOMAINS.some(d => emailLower.includes(d))) {
    return { isSpam: true, reason: 'newsletter' }
  }

  // 4. Check bulk sender platforms
  if (BULK_SENDER_PATTERNS.some(p => emailLower.includes(p))) {
    return { isSpam: true, reason: 'marketing' }
  }

  // 5. Check newsletter subject keywords
  if (NEWSLETTER_SUBJECT_KEYWORDS.some(kw => subjectLower.includes(kw))) {
    return { isSpam: true, reason: 'newsletter' }
  }

  // 6. Check body for unsubscribe links (strong newsletter indicator)
  if (bodyLower.includes('unsubscribe') || bodyLower.includes('email preferences') || bodyLower.includes('opt out') || bodyLower.includes('manage your subscriptions')) {
    return { isSpam: true, reason: 'newsletter' }
  }

  // 7. Check for empty/very short messages
  if (messageText.trim().length < 10) {
    return { isSpam: true, reason: 'spam' }
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

    // Trigger email notifications (async, non-blocking)
    if (!spamResult.isSpam) {
      try {
        const { triggerNotifications } = await import('@/lib/notification-service')
        triggerNotifications(supabase, {
          id: message.id,
          conversation_id: conversationId,
          account_id: account_id,
          account_name: accountRow.name || 'Unknown',
          channel: 'email',
          sender_name: senderName || senderEmail,
          email_subject: subject || null,
          message_text: plainTextBody?.substring(0, 200) || null,
          is_spam: spamResult.isSpam,
        }).catch(err => console.error('Notification trigger failed:', err))
      } catch (notifErr) {
        console.error('Failed to load notification service:', notifErr)
      }
    }

    // Skip AI processing for spam messages (save costs)
    if (!spamResult.isSpam) {
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
              message_text: plainTextBody,
              channel: 'email',
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
          console.error(`Phase 1 classification failed [message_id=${message.id}, account_id=${account_id}, channel=email]:`, classifyError instanceof Error ? classifyError.message : classifyError)
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
