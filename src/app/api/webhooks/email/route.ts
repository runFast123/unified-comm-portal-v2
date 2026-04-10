import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { logInfo, logError } from '@/lib/logger'
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

// Only include dedicated email marketing / newsletter platforms — NOT general enterprise domains
const NEWSLETTER_SENDER_DOMAINS = [
  'mailchimp.com', 'sendgrid.net', 'hubspot.com', 'constantcontact.com',
  'campaign-archive.com', 'createsend.com', 'mailgun.org',
  'substack.com', 'ghost.io',
]

// Noreply-prefixed addresses from any domain are likely automated
const NOREPLY_PREFIXES = [
  'noreply@', 'no-reply@', 'donotreply@', 'do-not-reply@',
  'notifications@', 'notification@', 'alerts@', 'alert@',
  'updates@', 'update@', 'news@', 'newsletter@', 'digest@',
  'mailer@', 'mailer-daemon@', 'postmaster@',
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

  // 3. Check newsletter sender domains (only dedicated email marketing platforms)
  if (NEWSLETTER_SENDER_DOMAINS.some(d => emailLower.includes(d))) {
    return { isSpam: true, reason: 'newsletter' }
  }

  // 4. Check noreply/automated sender prefixes
  if (NOREPLY_PREFIXES.some(p => emailLower.startsWith(p))) {
    return { isSpam: true, reason: 'automated_notification' }
  }

  // 5. Check bulk sender platforms
  if (BULK_SENDER_PATTERNS.some(p => emailLower.includes(p))) {
    return { isSpam: true, reason: 'marketing' }
  }

  // 6. Check newsletter subject keywords
  if (NEWSLETTER_SUBJECT_KEYWORDS.some(kw => subjectLower.includes(kw))) {
    return { isSpam: true, reason: 'newsletter' }
  }

  // 7. Check body: require multiple spam signals (not just "unsubscribe" alone)
  const spamBodySignals = [
    bodyLower.includes('unsubscribe'),
    bodyLower.includes('email preferences'),
    bodyLower.includes('opt out'),
    bodyLower.includes('manage your subscriptions'),
    bodyLower.includes('view in browser'),
    bodyLower.includes('view this email'),
  ].filter(Boolean).length
  if (spamBodySignals >= 2) {
    return { isSpam: true, reason: 'newsletter' }
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

    // Dedup check: skip if exact same message text was received recently (within 5 minutes) for this account
    // Note: thread_id is NOT used for dedup because multiple messages share the same thread
    if (plainTextBody && plainTextBody.trim().length > 0) {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      const { data: existingMsg } = await supabase
        .from('messages')
        .select('id')
        .eq('account_id', account_id)
        .eq('channel', 'email')
        .eq('direction', 'inbound')
        .like('message_text', plainTextBody.substring(0, 100).replace(/%/g, '\\%').replace(/_/g, '\\_') + '%')
        .gte('timestamp', fiveMinAgo)
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
        sender_name: senderName || sender || null,
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

    logInfo('webhook', 'email_received', `Email from ${senderEmail}`, { account_id, message_id: message.id, is_spam: spamResult.isSpam })
    return NextResponse.json(
      { message_id: message.id, is_spam: spamResult.isSpam },
      { status: 201 }
    )
  } catch (error) {
    console.error('Email webhook error:', error)
    logError('webhook', 'email_error', error instanceof Error ? error.message : 'Unknown error')
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
