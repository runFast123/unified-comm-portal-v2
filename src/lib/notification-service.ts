/**
 * Notification Service
 * Fetches matching notification rules and sends email + Slack notifications
 * for incoming messages. Runs fire-and-forget (non-blocking on the caller).
 *
 * Slack delivery uses the standard Incoming Webhook payload format with
 * Block Kit structure. Each delivery is wrapped in try/catch + a 5-second
 * timeout so a slow / dead Slack endpoint never blocks the email path or
 * the message-ingest request that fired this off.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import nodemailer from 'nodemailer'
import { logInfo, logError } from '@/lib/logger'

export interface NotificationMessageData {
  id: string
  conversation_id: string
  account_id: string
  account_name: string
  channel: 'email' | 'teams' | 'whatsapp'
  sender_name: string | null
  sender_email?: string | null
  email_subject: string | null
  message_text: string | null
  is_spam: boolean
  priority?: 'low' | 'medium' | 'high' | 'urgent'
}

const PRIORITY_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  urgent: 3,
}

/** Hard cap on Slack POST so a hung webhook can't block ingest. */
const SLACK_TIMEOUT_MS = 5000

function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'urgent': return '#dc2626'
    case 'high': return '#ea580c'
    case 'medium': return '#2563eb'
    case 'low': return '#16a34a'
    default: return '#2563eb'
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Build the Slack Incoming Webhook Block Kit payload for a new message.
 *
 * Exported for unit testing — callers should use `sendSlackNotification`.
 * The shape mirrors the spec in the task brief: a fallback `text`, a header
 * section with mrkdwn From / Account / Subject, a quoted preview, and an
 * action button linking back to the conversation in the portal.
 */
export function buildSlackPayload(opts: {
  channelLabel: string
  priority: string
  accountName: string
  senderName: string
  senderEmail: string | null
  subject: string | null
  preview: string
  conversationUrl: string
}): {
  text: string
  blocks: Array<Record<string, unknown>>
} {
  const { channelLabel, priority, accountName, senderName, senderEmail, subject, preview, conversationUrl } = opts
  const fromLine = senderEmail ? `${senderName} <${senderEmail}>` : senderName
  const subjectLine = subject ? `\n*Subject:* ${subject}` : ''
  const headerText =
    `*New ${channelLabel.toLowerCase()}* on *${accountName}*\n` +
    `*From:* ${fromLine}` +
    subjectLine

  return {
    text: `New ${channelLabel.toLowerCase()} from ${senderName} (${priority})`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: headerText },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `> ${preview.replace(/\n/g, '\n> ')}` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open in Portal' },
            url: conversationUrl,
          },
        ],
      },
    ],
  }
}

/**
 * POST a Slack Block Kit payload to an Incoming Webhook URL.
 *
 * Always resolves — callers should not need to try/catch. Returns `true`
 * on a 2xx response, `false` on any error, non-2xx, or timeout. Logs the
 * outcome via the structured logger (`slack_notification_sent` /
 * `slack_notification_failed`).
 *
 * `extraMeta` is merged into the log payload for correlation (account_id,
 * conversation_id, etc).
 */
export async function sendSlackNotification(
  webhookUrl: string,
  payload: { text: string; blocks: Array<Record<string, unknown>> },
  extraMeta: Record<string, unknown> = {}
): Promise<boolean> {
  if (!webhookUrl) return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS)

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      await logError('notification', 'slack_notification_failed', `Slack webhook returned ${response.status}`, {
        ...extraMeta,
        status: response.status,
        body: body.slice(0, 200),
      })
      return false
    }

    await logInfo('notification', 'slack_notification_sent', 'Slack webhook delivered', extraMeta)
    return true
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    await logError(
      'notification',
      'slack_notification_failed',
      isTimeout ? 'Slack webhook timed out' : err instanceof Error ? err.message : String(err),
      { ...extraMeta, timeout: isTimeout }
    )
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Trigger notifications for a new message: email + Slack.
 * Runs fire-and-forget — the caller does not block on delivery results.
 *
 * Spam-flagged messages are silently skipped to avoid alerting on noise.
 */
export async function triggerNotifications(
  supabase: SupabaseClient,
  messageData: NotificationMessageData
): Promise<void> {
  try {
    if (messageData.is_spam) return

    const { data: rules, error } = await supabase
      .from('notification_rules')
      .select('*')
      .eq('is_active', true)

    if (error || !rules || rules.length === 0) return

    const messagePriority = messageData.priority || 'medium'
    const messagePriorityValue = PRIORITY_ORDER[messagePriority] ?? 1

    const matchingRules = rules.filter((rule: Record<string, unknown>) => {
      if (rule.channel && rule.channel !== messageData.channel) return false
      if (rule.account_id && rule.account_id !== messageData.account_id) return false
      const ruleMinPriority = PRIORITY_ORDER[rule.min_priority as string] ?? 1
      if (messagePriorityValue < ruleMinPriority) return false
      return true
    })

    if (matchingRules.length === 0) return

    const portalUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://unified-comm-portal.vercel.app'
    const messagePreview = messageData.message_text?.substring(0, 200) || '(no content)'
    const priorityLabel = messagePriority.toUpperCase()
    const channelLabel = messageData.channel.charAt(0).toUpperCase() + messageData.channel.slice(1)
    const conversationUrl = `${portalUrl}/conversations/${messageData.conversation_id}`

    // ── Email path ────────────────────────────────────────────────
    const smtpUser = process.env.SMTP_USER
    const smtpPassword = process.env.SMTP_PASSWORD
    const emailRules = matchingRules.filter(
      (rule: Record<string, unknown>) => rule.notify_email && rule.notify_email_address
    )

    const emailPromises: Promise<unknown>[] = []
    if (emailRules.length > 0 && smtpUser && smtpPassword) {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user: smtpUser, pass: smtpPassword },
      })

      for (const rule of emailRules) {
        emailPromises.push(
          (async () => {
            try {
              await transporter.sendMail({
                from: `"Unified Comms Portal" <${smtpUser}>`,
                to: rule.notify_email_address as string,
                subject: `[${priorityLabel}] New message from ${messageData.sender_name || 'Unknown'} — ${messageData.account_name}`,
                html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
  <div style="background:#1e293b;padding:16px 24px;"><h1 style="margin:0;color:#fff;font-size:16px;">Unified Comms Portal</h1></div>
  <div style="padding:20px 24px;">
    <span style="display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600;color:#fff;background:${getPriorityColor(messagePriority)};">${priorityLabel}</span>
    <h2 style="margin:12px 0 16px;font-size:15px;color:#1e293b;">New message received</h2>
    <table style="width:100%;font-size:13px;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#64748b;width:100px;">From</td><td style="padding:6px 0;color:#1e293b;font-weight:500;">${escapeHtml(messageData.sender_name || 'Unknown')}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b;">Account</td><td style="padding:6px 0;color:#1e293b;">${escapeHtml(messageData.account_name)}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b;">Channel</td><td style="padding:6px 0;color:#1e293b;">${channelLabel}</td></tr>
      ${messageData.email_subject ? `<tr><td style="padding:6px 0;color:#64748b;">Subject</td><td style="padding:6px 0;color:#1e293b;">${escapeHtml(messageData.email_subject)}</td></tr>` : ''}
    </table>
    <div style="background:#f8fafc;border-left:3px solid #3b82f6;padding:10px 14px;margin:16px 0;border-radius:0 4px 4px 0;">
      <p style="margin:0 0 4px;font-size:11px;color:#64748b;text-transform:uppercase;">Preview</p>
      <p style="margin:0;font-size:13px;color:#334155;line-height:1.5;">${escapeHtml(messagePreview)}</p>
    </div>
    <a href="${conversationUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:8px 20px;border-radius:6px;font-size:13px;font-weight:500;">View Conversation</a>
  </div>
  <div style="padding:12px 24px;border-top:1px solid #e2e8f0;"><p style="margin:0;font-size:11px;color:#94a3b8;">Unified Communication Portal notification</p></div>
</div>`.trim(),
              })
              console.log(`Notification email sent to ${rule.notify_email_address} for message ${messageData.id}`)
            } catch (sendError) {
              console.error(
                `Failed to send notification to ${rule.notify_email_address}:`,
                sendError instanceof Error ? sendError.message : sendError
              )
            }
          })()
        )
      }
    } else if (emailRules.length > 0) {
      console.error('SMTP_USER or SMTP_PASSWORD not configured — skipping email notifications')
    }

    // ── Slack path ────────────────────────────────────────────────
    // Each rule with notify_slack + slack_webhook_url gets its own POST.
    // sendSlackNotification swallows errors internally, so a 500 from one
    // workspace can't bring down the email path or other Slack workspaces.
    const slackPromises = matchingRules
      .filter((rule: Record<string, unknown>) => rule.notify_slack && rule.slack_webhook_url)
      .map((rule: Record<string, unknown>) => {
        const payload = buildSlackPayload({
          channelLabel,
          priority: priorityLabel,
          accountName: messageData.account_name,
          senderName: messageData.sender_name || 'Unknown',
          senderEmail: messageData.sender_email ?? null,
          subject: messageData.email_subject,
          preview: messagePreview,
          conversationUrl,
        })
        return sendSlackNotification(rule.slack_webhook_url as string, payload, {
          rule_id: rule.id,
          message_id: messageData.id,
          conversation_id: messageData.conversation_id,
          account_id: messageData.account_id,
          channel: messageData.channel,
          priority: messagePriority,
        })
      })

    await Promise.allSettled([...emailPromises, ...slackPromises])
  } catch (outerError) {
    console.error('triggerNotifications error:', outerError instanceof Error ? outerError.message : outerError)
  }
}
