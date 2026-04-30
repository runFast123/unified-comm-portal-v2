/**
 * Email ingest core — the business logic that turns a parsed inbound email
 * into a stored conversation/message and dispatches the AI pipeline.
 *
 * Extracted from `src/app/api/webhooks/email/route.ts` so it can be invoked
 * either by the webhook route (external HTTP callers) OR directly in-process
 * from the IMAP poller. Going through the webhook over HTTP from the poller
 * was a footgun because Vercel Deployment Protection intercepts the internal
 * request with an HTML auth wall (which the poller then surfaces as
 * "webhook responded 401: <!doctype html>...") — silently dropping every
 * polled message. Calling this function directly removes the network hop
 * entirely, makes the cursor advance + message store atomic in a single
 * lambda, and saves a roundtrip per message.
 */
import { after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logInfo, logError } from '@/lib/logger'
import { findOrCreateConversation, getAccountSettings, stripHtml, checkRateLimit } from '@/lib/api-helpers'
import { detectSpam } from '@/lib/spam-detection'
import { evaluateRouting, applyRoutingResult } from '@/lib/routing-engine'
import { REQUEST_ID_HEADER } from '@/lib/request-id'

export interface InboundEmailPayload {
  account_id: string
  /** Raw "Display Name" <addr> or just addr — we'll parse it. */
  sender: string
  subject?: string | null
  /** Raw body (HTML or text). HTML will be stripped. */
  body?: string | null
  thread_id?: string | null
  attachments?: unknown
}

/**
 * Result shape mirrors the webhook's HTTP semantics so the route handler
 * can map cleanly to NextResponse codes. `http_code` is the suggested
 * status the route should return.
 */
export type IngestResult =
  | { ok: true; status: 'created'; message_id: string; conversation_id: string; is_spam: boolean; http_code: 201 }
  | { ok: true; status: 'duplicate'; message_id: string; http_code: 200 }
  | { ok: false; status: 'invalid_input' | 'rate_limited' | 'account_not_found' | 'account_inactive' | 'store_failed'; error: string; http_code: 400 | 429 | 404 | 403 | 500 }

/**
 * Turn an inbound email payload into a stored message + conversation,
 * fire spam/routing/notifications, and (via `after()`) hand off to the
 * AI pipeline. Idempotent on duplicate body within 5 minutes.
 *
 * @param supabase  Service-role client. Caller is responsible for using the
 *                  service role; this function bypasses RLS by design.
 * @param payload   Parsed inbound message
 * @param ctx       Per-call context — origin (for the AI dispatch fetches)
 *                  and request_id (for log correlation). When called from
 *                  the cron poller, both come from the cron route handler.
 */
export async function ingestInboundEmail(
  supabase: SupabaseClient,
  payload: InboundEmailPayload,
  ctx: { origin: string; request_id: string }
): Promise<IngestResult> {
  const { account_id, sender, subject, body: emailBody, thread_id, attachments } = payload
  const requestId = ctx.request_id

  // ── Validate ─────────────────────────────────────────────────────
  if (!account_id) {
    return { ok: false, status: 'invalid_input', error: 'Missing required field: account_id', http_code: 400 }
  }
  if (!sender || (typeof sender === 'string' && sender.trim().length === 0)) {
    return { ok: false, status: 'invalid_input', error: 'Missing or empty required field: sender', http_code: 400 }
  }

  // Per-account rate limit. 100 inbound/min is a conservative ceiling that
  // protects the AI pipeline from a runaway upstream — same guard the HTTP
  // webhook applies, so behavior is identical regardless of caller.
  if (!(await checkRateLimit(`webhook:email:${account_id}`, 100, 60))) {
    return { ok: false, status: 'rate_limited', error: 'Rate limit exceeded. Try again later.', http_code: 429 }
  }

  // ── Parse RFC 5322 sender ───────────────────────────────────────
  // Accepts `"Display Name" <addr>` or just `addr`. Strips quotes from
  // display name. Falls back to the raw value if no angle brackets.
  const emailMatch = sender.match(/<([^>]+)>/)
  const senderEmail = emailMatch ? emailMatch[1].trim() : sender
  const senderName = emailMatch
    ? sender.slice(0, sender.indexOf('<')).trim().replace(/^["']|["']$/g, '') || senderEmail
    : sender

  // ── Strip HTML + truncate ───────────────────────────────────────
  const MAX_MESSAGE_LENGTH = 50000 // 50KB
  let plainTextBody = emailBody ? stripHtml(emailBody) : ''
  if (plainTextBody.length > MAX_MESSAGE_LENGTH) {
    plainTextBody = plainTextBody.substring(0, MAX_MESSAGE_LENGTH) + '... [truncated]'
  }

  // ── Account exists + active ─────────────────────────────────────
  const { data: accountRow, error: accountError } = await supabase
    .from('accounts')
    .select('id, name, is_active, spam_detection_enabled, spam_allowlist')
    .eq('id', account_id)
    .single()

  if (accountError || !accountRow) {
    return { ok: false, status: 'account_not_found', error: 'Account not found', http_code: 404 }
  }
  if (!accountRow.is_active) {
    return { ok: false, status: 'account_inactive', error: 'Account is not active', http_code: 403 }
  }

  // ── Dedup ───────────────────────────────────────────────────────
  // Same body prefix from same account within 5 min → already processed.
  // thread_id is intentionally NOT used (multiple messages share threads).
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
      return { ok: true, status: 'duplicate', message_id: existingMsg.id, http_code: 200 }
    }
  }

  // ── Spam detection ──────────────────────────────────────────────
  // Honours per-account overrides. spam_detection_enabled=false → never spam.
  // Allowlisted senders bypass the heuristic regardless of content.
  const spamResult = detectSpam(senderEmail, subject || null, plainTextBody, {
    enabled: accountRow.spam_detection_enabled ?? true,
    allowlist: (accountRow.spam_allowlist as string[]) ?? [],
  })

  // ── Conversation + message ──────────────────────────────────────
  const conversationId = await findOrCreateConversation(supabase, {
    account_id,
    channel: 'email',
    participant_name: senderName,
    participant_email: senderEmail,
  })

  const { data: message, error: msgError } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      account_id,
      channel: 'email',
      sender_name: senderName || sender,
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
    logError('webhook', 'email_store_failed', msgError?.message || 'unknown insert failure', {
      request_id: requestId,
      account_id,
    })
    return { ok: false, status: 'store_failed', error: 'Failed to store message', http_code: 500 }
  }

  // ── Routing rules ───────────────────────────────────────────────
  // Skip for spam (avoid mutating spam threads). Fail-soft so a routing
  // engine bug never blocks ingest.
  if (!spamResult.isSpam) {
    try {
      const routingResult = await evaluateRouting({
        channel: 'email',
        account_id,
        sender_email: senderEmail,
        sender_phone: null,
        subject: subject || null,
        message_text: plainTextBody,
      })
      if (routingResult.matched_rule_ids.length > 0) {
        const applied = await applyRoutingResult(supabase, conversationId, routingResult)
        logInfo('webhook', 'rule_matched', `Routing matched ${routingResult.matched_rule_ids.length} rule(s)`, {
          request_id: requestId,
          account_id,
          message_id: message.id,
          conversation_id: conversationId,
          matched_rule_ids: routingResult.matched_rule_ids,
          applied,
        })
      }
    } catch (routingErr) {
      logError('webhook', 'routing_failed', routingErr instanceof Error ? routingErr.message : 'unknown', {
        request_id: requestId,
        account_id,
        message_id: message.id,
      })
    }
  }

  // ── Notifications (async, non-blocking) ─────────────────────────
  if (!spamResult.isSpam) {
    try {
      const { triggerNotifications } = await import('@/lib/notification-service')
      triggerNotifications(supabase, {
        id: message.id,
        conversation_id: conversationId,
        account_id,
        account_name: accountRow.name || 'Unknown',
        channel: 'email',
        sender_name: senderName || senderEmail,
        email_subject: subject || null,
        message_text: plainTextBody?.substring(0, 200) || null,
        is_spam: spamResult.isSpam,
      }).catch((err) => console.error('Notification trigger failed:', err))
    } catch (notifErr) {
      console.error('Failed to load notification service:', notifErr)
    }
  }

  // ── AI dispatch (Phase 1 + Phase 2) via after() ─────────────────
  // Fired post-response so the caller (webhook handler OR cron poller)
  // returns / advances to the next message immediately. The fetches still
  // go over HTTP because /classify and /ai-reply are full route handlers
  // with their own auth/rate-limit/timeout characteristics — not worth
  // hoisting them in-process for one message.
  if (!spamResult.isSpam) {
    const account = await getAccountSettings(supabase, account_id)
    const headers = {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '',
      [REQUEST_ID_HEADER]: requestId,
    }

    if (account.phase1_enabled) {
      after(() =>
        fetch(`${ctx.origin}/api/classify`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message_id: message.id,
            message_text: plainTextBody,
            channel: 'email',
            account_id,
          }),
        }).catch((err) =>
          console.error(
            `Phase 1 classify dispatch failed [message_id=${message.id}]:`,
            err instanceof Error ? err.message : err
          )
        )
      )
    }

    if (account.phase2_enabled) {
      after(() =>
        fetch(`${ctx.origin}/api/ai-reply`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message_id: message.id,
            message_text: plainTextBody,
            channel: 'email',
            account_id,
            conversation_id: conversationId,
          }),
        }).catch((err) =>
          console.error(
            `Phase 2 AI reply dispatch failed [message_id=${message.id}]:`,
            err instanceof Error ? err.message : err
          )
        )
      )
    }
  }

  logInfo('webhook', 'email_received', `Email from ${senderEmail}`, {
    request_id: requestId,
    account_id,
    message_id: message.id,
    is_spam: spamResult.isSpam,
  })

  return {
    ok: true,
    status: 'created',
    message_id: message.id,
    conversation_id: conversationId,
    is_spam: spamResult.isSpam,
    http_code: 201,
  }
}
