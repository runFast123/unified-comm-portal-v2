/**
 * Notification Service
 * Fetches matching notification rules and triggers email notifications
 * for incoming messages. Runs fire-and-forget (non-blocking).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface NotificationMessageData {
  id: string
  conversation_id: string
  account_id: string
  account_name: string
  channel: 'email' | 'teams' | 'whatsapp'
  sender_name: string | null
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

/**
 * Trigger email notifications for a new message.
 * Fetches active notification_rules matching the message's channel/account,
 * filters by priority, and fires off email requests to /api/notifications/send.
 *
 * This function is async fire-and-forget: call it without awaiting.
 * All errors are caught internally so it never blocks the caller.
 */
export async function triggerNotifications(
  supabase: SupabaseClient,
  messageData: NotificationMessageData
): Promise<void> {
  try {
    // Skip notifications for spam messages
    if (messageData.is_spam) return

    // Fetch active notification rules that match this message
    // Rules with NULL channel/account_id apply to all channels/accounts
    const { data: rules, error } = await supabase
      .from('notification_rules')
      .select('*')
      .eq('is_active', true)

    if (error) {
      console.error('Failed to fetch notification rules:', error.message)
      return
    }

    if (!rules || rules.length === 0) return

    const messagePriority = messageData.priority || 'medium'
    const messagePriorityValue = PRIORITY_ORDER[messagePriority] ?? 1

    // Filter rules that match this message
    const matchingRules = rules.filter((rule) => {
      // Channel filter: rule.channel must be NULL (all) or match
      if (rule.channel && rule.channel !== messageData.channel) return false

      // Account filter: rule.account_id must be NULL (all) or match
      if (rule.account_id && rule.account_id !== messageData.account_id) return false

      // Priority filter: message priority must be >= rule's min_priority
      const ruleMinPriority = PRIORITY_ORDER[rule.min_priority] ?? 1
      if (messagePriorityValue < ruleMinPriority) return false

      return true
    })

    if (matchingRules.length === 0) return

    // Build the base URL from environment or fall back
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
      || process.env.NEXTAUTH_URL
      || 'http://localhost:3000'

    const messagePreview = messageData.message_text
      ? messageData.message_text.substring(0, 200)
      : '(no content)'

    // Send email notifications in parallel (fire-and-forget per rule)
    const emailPromises = matchingRules
      .filter((rule) => rule.notify_email && rule.notify_email_address)
      .map(async (rule) => {
        try {
          await fetch(`${baseUrl}/api/notifications/send`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Secret': process.env.N8N_WEBHOOK_SECRET || '',
            },
            body: JSON.stringify({
              to: rule.notify_email_address,
              sender_name: messageData.sender_name || 'Unknown',
              account_name: messageData.account_name,
              channel: messageData.channel,
              subject: messageData.email_subject || null,
              message_preview: messagePreview,
              conversation_id: messageData.conversation_id,
              priority: messagePriority,
            }),
            signal: AbortSignal.timeout(15000),
          })
        } catch (sendError) {
          console.error(
            `Failed to send email notification to ${rule.notify_email_address}:`,
            sendError instanceof Error ? sendError.message : sendError
          )
        }
      })

    await Promise.allSettled(emailPromises)
  } catch (outerError) {
    // Catch-all so this never throws to the caller
    console.error(
      'triggerNotifications unexpected error:',
      outerError instanceof Error ? outerError.message : outerError
    )
  }
}
