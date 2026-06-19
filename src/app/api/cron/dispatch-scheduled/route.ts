import { NextResponse } from 'next/server'
import nodemailer from 'nodemailer'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { sendViaChannel } from '@/lib/channels/adapters'
import { resolveRecipient } from '@/lib/channels/registry'
import { validateWebhookSecret, getReplyToMessageId } from '@/lib/api-helpers'
import { logError, logInfo } from '@/lib/logger'
import { getRequestId } from '@/lib/request-id'
import { recordMetric } from '@/lib/metrics'
import { createNotification } from '@/lib/notifications'

// Per-run cap so a backlog never monopolises one invocation.
const BATCH_LIMIT = 50

type Channel = 'email' | 'teams' | 'whatsapp'

interface ScheduledRow {
  id: string
  conversation_id: string
  account_id: string
  channel: Channel
  reply_text: string
  to_address: string | null
  subject: string | null
  teams_chat_id: string | null
  attachments: unknown
  scheduled_for: string
  created_by: string | null
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Email the agent whose queued reply just failed to dispatch, so the
 * failure isn't invisible (no timeline row exists for a failed send).
 *
 * Fail-soft by design: every error is logged and swallowed so a broken
 * SMTP config can never break the dispatch loop. Fires on the state
 * TRANSITION only — the claim CAS guarantees each row goes
 * pending → failed at most once per queue attempt (a user-initiated
 * retry resets to 'pending', making a second failure a new transition),
 * so this can't spam on every cron run.
 */
async function notifySenderOfFailure(
  admin: Awaited<ReturnType<typeof createServiceRoleClient>>,
  opts: {
    createdBy: string | null
    conversationId: string
    channel: string
    toAddress: string | null
    error: string
    kind: 'scheduled' | 'pending_send'
    requestId: string
  }
): Promise<void> {
  try {
    if (!opts.createdBy) return
    const smtpUser = process.env.SMTP_USER
    const smtpPassword = process.env.SMTP_PASSWORD
    if (!smtpUser || !smtpPassword) return

    const { data: sender } = await admin
      .from('users')
      .select('email')
      .eq('id', opts.createdBy)
      .maybeSingle()
    const senderEmail = (sender as { email: string | null } | null)?.email
    if (!senderEmail) return

    const portalUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://unified-comm-portal.vercel.app'
    const conversationUrl = `${portalUrl}/conversations/${opts.conversationId}`
    const recipientLabel = opts.toAddress || `the ${opts.channel} recipient`

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: smtpUser, pass: smtpPassword },
    })
    await transporter.sendMail({
      from: `"Unified Comms Portal" <${smtpUser}>`,
      to: senderEmail,
      subject: `Your reply to ${recipientLabel} failed to send`,
      html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
  <div style="background:#1e293b;padding:16px 24px;"><h1 style="margin:0;color:#fff;font-size:16px;">Unified Comms Portal</h1></div>
  <div style="padding:20px 24px;">
    <h2 style="margin:0 0 12px;font-size:15px;color:#dc2626;">Your reply to ${escapeHtml(recipientLabel)} failed to send</h2>
    <p style="margin:0 0 16px;font-size:13px;color:#334155;line-height:1.5;">The customer did not receive it. Open the conversation to retry.</p>
    <div style="background:#fef2f2;border-left:3px solid #dc2626;padding:10px 14px;margin:0 0 20px;border-radius:0 4px 4px 0;">
      <p style="margin:0 0 4px;font-size:11px;color:#64748b;text-transform:uppercase;">Error</p>
      <p style="margin:0;font-size:13px;color:#334155;line-height:1.5;">${escapeHtml(opts.error.slice(0, 300))}</p>
    </div>
    <a href="${conversationUrl}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:8px 20px;border-radius:6px;font-size:13px;font-weight:500;">Open Conversation</a>
  </div>
  <div style="padding:12px 24px;border-top:1px solid #e2e8f0;"><p style="margin:0;font-size:11px;color:#94a3b8;">Unified Communication Portal notification</p></div>
</div>`.trim(),
    })
  } catch (err) {
    await logError(
      'system',
      'dispatch_failure_notify_failed',
      err instanceof Error ? err.message : String(err),
      {
        request_id: opts.requestId,
        conversation_id: opts.conversationId,
        kind: opts.kind,
        channel: opts.channel,
      }
    )
  }
}

/**
 * Authorize cron invocation. Accepts either `X-Webhook-Secret` (internal
 * callers) or `Authorization: Bearer <WEBHOOK_SECRET>` (Vercel Cron).
 * Timing-safe comparison via validateWebhookSecret.
 */
function authorizeCron(request: Request): boolean {
  if (validateWebhookSecret(request)) return true
  // Also accept Authorization: Bearer <secret> for Vercel Cron compatibility.
  // Adapt by shimming the header onto a lightweight Request clone.
  const auth = request.headers.get('authorization')
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  if (!bearer) return false
  const shim = new Request(request.url, {
    method: 'GET',
    headers: { 'x-webhook-secret': bearer },
  })
  return validateWebhookSecret(shim)
}

/**
 * Cron dispatcher for scheduled messages.
 *
 * Concurrency + ordering guarantees:
 *   1. We CLAIM each row via an UPDATE ... WHERE status='pending' so two
 *      overlapping cron runs can't dispatch the same message twice.
 *   2. We insert the outbound `messages` row BEFORE flipping the
 *      scheduled row to 'sent' — that way the timeline always reflects
 *      what got sent. If the message insert fails post-send, we still
 *      mark 'sent' (the remote delivery actually happened) but log a
 *      LOUD audit + error so the gap is visible.
 */
export async function GET(request: Request) {
  const requestId = await getRequestId()
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 })
  }

  const admin = await createServiceRoleClient()
  const nowIso = new Date().toISOString()
  const startedAt = Date.now()
  logInfo('system', 'dispatch_scheduled_start', 'dispatch-scheduled cron started', {
    request_id: requestId,
  })

  const { data: rows, error } = await admin
    .from('scheduled_messages')
    .select('id, conversation_id, account_id, channel, reply_text, to_address, subject, teams_chat_id, attachments, scheduled_for, created_by')
    .eq('status', 'pending')
    .lte('scheduled_for', nowIso)
    .order('scheduled_for', { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    const durationMs = Date.now() - startedAt
    logError('system', 'dispatch_scheduled_query_error', error.message, { request_id: requestId })
    recordMetric('cron.dispatch_scheduled.duration_ms', durationMs, { success: false }, requestId)
    recordMetric('cron.dispatch_scheduled.errors', 1, { stage: 'query', fatal: true }, requestId)
    return NextResponse.json({ error: error.message, request_id: requestId }, { status: 500 })
  }

  const scheduled = (rows ?? []) as ScheduledRow[]
  const errors: Array<{ id: string; error: string }> = []
  let dispatched = 0
  let failed = 0
  let skipped = 0

  for (const row of scheduled) {
    // ── Claim: compare-and-set pending → dispatching. Zero rows affected
    //    means another worker already claimed it; skip.
    const { data: claimed, error: claimErr } = await admin
      .from('scheduled_messages')
      .update({ status: 'dispatching' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()

    if (claimErr) {
      errors.push({ id: row.id, error: `claim failed: ${claimErr.message}` })
      failed++
      continue
    }
    if (!claimed) {
      // Another worker got it first (or the row changed status between
      // our SELECT and UPDATE). Not an error — just move on.
      skipped++
      continue
    }

    try {
      let result
      if (row.channel === 'email') {
        if (!row.to_address) {
          throw new Error('Missing recipient email on scheduled row')
        }
        // Thread against the conversation's latest inbound email so the
        // dispatched reply stays in the same thread (In-Reply-To / References).
        const replyToMessageId = await getReplyToMessageId(admin, row.conversation_id)
        result = await sendViaChannel(row.channel, {
          accountId: row.account_id,
          to: row.to_address,
          subject: row.subject,
          body: row.reply_text,
          replyToMessageId,
        })
      } else {
        // Non-email channels: registry-driven recipient (teams -> chat id,
        // whatsapp/sms -> phone). The scheduled row carries to_address +
        // teams_chat_id.
        const to = resolveRecipient(row.channel, {
          teams_chat_id: row.teams_chat_id,
          participant_phone: row.to_address,
          participant_email: row.to_address,
        })
        if (!to) {
          throw new Error(`Missing recipient for ${row.channel} on scheduled row`)
        }
        result = await sendViaChannel(row.channel, {
          accountId: row.account_id,
          to,
          body: row.reply_text,
        })
      }

      if (!result.ok) {
        throw new Error(result.error)
      }

      // ── Successful send. Insert the outbound message FIRST so the
      //    timeline reflects reality even if the status flip fails.
      const { data: acct } = await admin
        .from('accounts')
        .select('name')
        .eq('id', row.account_id)
        .maybeSingle()
      const senderName = (acct?.name || '').replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim() || 'Agent'

      const sentAt = new Date().toISOString()

      let messageInsertError: string | null = null
      try {
        const { error: msgErr } = await admin.from('messages').insert({
          conversation_id: row.conversation_id,
          account_id: row.account_id,
          channel: row.channel,
          sender_name: senderName,
          sender_type: 'agent',
          message_text: row.reply_text,
          direction: 'outbound',
          email_subject: row.subject || null,
          attachments: row.attachments ?? null,
          replied: true,
          reply_required: false,
          timestamp: sentAt,
          received_at: sentAt,
        })
        if (msgErr) messageInsertError = msgErr.message
      } catch (insertErr) {
        messageInsertError = insertErr instanceof Error ? insertErr.message : 'unknown insert failure'
      }

      if (messageInsertError) {
        // Remote delivery succeeded but we couldn't record it locally.
        // Don't leave the row stuck as 'dispatching' — flip to 'sent' so
        // it doesn't get re-dispatched, and log LOUDLY so an admin can
        // backfill if needed.
        await admin
          .from('scheduled_messages')
          .update({ status: 'sent', sent_at: sentAt, error: `message_insert_failed: ${messageInsertError}` })
          .eq('id', row.id)

        await logError(
          'system',
          'dispatch.message_insert_failed',
          `Scheduled message dispatched but timeline row insert failed`,
          {
            request_id: requestId,
            scheduled_id: row.id,
            account_id: row.account_id,
            conversation_id: row.conversation_id,
            channel: row.channel,
            error: messageInsertError,
          }
        )

        await admin.from('audit_log').insert({
          user_id: null,
          action: 'dispatch.message_insert_failed',
          entity_type: 'scheduled_message',
          entity_id: row.id,
          details: {
            conversation_id: row.conversation_id,
            channel: row.channel,
            error: messageInsertError,
            request_id: requestId,
          },
        })

        dispatched++
        errors.push({ id: row.id, error: `sent_but_no_timeline: ${messageInsertError}` })
        continue
      }

      // Flip row to 'sent' only after the outbound message row is safely
      // in place.
      await admin
        .from('scheduled_messages')
        .update({ status: 'sent', sent_at: sentAt, error: null })
        .eq('id', row.id)

      // Also clear the inbound replied flag so the conversation exits "needs reply".
      await admin
        .from('messages')
        .update({ replied: true })
        .eq('conversation_id', row.conversation_id)
        .eq('direction', 'inbound')
        .eq('replied', false)

      dispatched++
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Dispatch failed'
      errors.push({ id: row.id, error: message })
      failed++
      // Revert our 'dispatching' claim to 'failed' with the error attached.
      await admin
        .from('scheduled_messages')
        .update({ status: 'failed', error: message })
        .eq('id', row.id)
      // Tell the agent who queued it — fire-and-forget, never blocks the loop.
      void notifySenderOfFailure(admin, {
        createdBy: row.created_by,
        conversationId: row.conversation_id,
        channel: row.channel,
        toAddress: row.to_address,
        error: message,
        kind: 'scheduled',
        requestId,
      })
      // Also surface it in the queuing agent's bell. Reuse the admin
      // (service-role) client; createNotification is fail-soft and no-ops on a
      // null user_id, so an unattributed queued row simply gets no bell entry.
      if (row.created_by) {
        void createNotification(
          {
            user_id: row.created_by,
            type: 'system_alert',
            title: 'Your reply failed to send',
            body: `To ${row.to_address || `the ${row.channel} recipient`}: ${message.slice(0, 200)}`,
            link: `/conversations/${row.conversation_id}`,
            conversation_id: row.conversation_id,
          },
          admin
        )
      }
    }
  }

  // ── Undo-Send pass ───────────────────────────────────────────────────
  // Same claim-and-send dance as scheduled_messages but for the
  // pending_sends table populated by /api/send when delay_ms > 0.
  // A row sits in 'pending' while the user has the chance to hit Undo;
  // once send_at passes (typically 5s after the click) we dispatch it.
  // Cron runs every minute, so worst-case latency between the undo
  // window expiring and the email actually leaving is ~60s.
  let pendingDispatched = 0
  let pendingFailed = 0
  let pendingSkipped = 0
  const pendingErrors: Array<{ id: string; error: string }> = []

  const { data: pendingRows, error: pendingQueryErr } = await admin
    .from('pending_sends')
    .select('id, conversation_id, account_id, channel, reply_text, to_address, subject, teams_chat_id, attachments, send_at, created_by')
    .eq('status', 'pending')
    .lte('send_at', nowIso)
    .order('send_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (pendingQueryErr) {
    logError('system', 'dispatch_pending_sends_query_error', pendingQueryErr.message, {
      request_id: requestId,
    })
  } else {
    for (const row of (pendingRows ?? []) as Array<{
      id: string
      conversation_id: string
      account_id: string
      channel: Channel
      reply_text: string
      to_address: string | null
      subject: string | null
      teams_chat_id: string | null
      attachments: unknown
      send_at: string
      created_by: string | null
    }>) {
      // Compare-and-set claim: pending → sending. Guards against double
      // dispatch if two cron invocations overlap or against the user
      // hitting Undo at the exact moment we picked the row up.
      const { data: claimed, error: claimErr } = await admin
        .from('pending_sends')
        .update({ status: 'sending' })
        .eq('id', row.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle()

      if (claimErr) {
        pendingErrors.push({ id: row.id, error: `claim failed: ${claimErr.message}` })
        pendingFailed++
        continue
      }
      if (!claimed) {
        // User hit Undo, or another worker claimed it first.
        pendingSkipped++
        continue
      }

      try {
        let result
        if (row.channel === 'email') {
          if (!row.to_address) throw new Error('Missing recipient email on pending row')
          // Attachments column is `{ attachments: [...] }` to match the
          // shape we stored in /api/send. Unwrap defensively.
          const attsRaw = (row.attachments as { attachments?: Array<{ path: string; filename: string; contentType?: string }> } | null)?.attachments
          const atts = Array.isArray(attsRaw) ? attsRaw : []
          // Thread the undo-window reply against the conversation's latest
          // inbound email (In-Reply-To / References) at dispatch time.
          const replyToMessageId = await getReplyToMessageId(admin, row.conversation_id)
          result = await sendViaChannel(row.channel, {
            accountId: row.account_id,
            to: row.to_address,
            subject: row.subject,
            body: row.reply_text,
            replyToMessageId,
            attachments: atts.length > 0
              ? atts.map((a) => ({ path: a.path, filename: a.filename, contentType: a.contentType }))
              : undefined,
          })
        } else {
          // Non-email channels: registry-driven recipient (teams -> chat id,
          // whatsapp/sms -> phone). The pending row carries to_address +
          // teams_chat_id.
          const to = resolveRecipient(row.channel, {
            teams_chat_id: row.teams_chat_id,
            participant_phone: row.to_address,
            participant_email: row.to_address,
          })
          if (!to) throw new Error(`Missing recipient for ${row.channel} on pending row`)
          result = await sendViaChannel(row.channel, {
            accountId: row.account_id,
            to,
            body: row.reply_text,
          })
        }

        if (!result.ok) throw new Error(result.error)

        const sentAt = new Date().toISOString()

        // Mirror the scheduled-messages flow: insert outbound timeline
        // row first, then flip status to 'sent'.
        const { data: acct } = await admin
          .from('accounts')
          .select('name')
          .eq('id', row.account_id)
          .maybeSingle()
        const senderName = (acct?.name || '')
          .replace(/\s+Teams$/i, '')
          .replace(/\s+WhatsApp$/i, '')
          .trim() || 'Agent'

        let messageInsertError: string | null = null
        try {
          const { error: msgErr } = await admin.from('messages').insert({
            conversation_id: row.conversation_id,
            account_id: row.account_id,
            channel: row.channel,
            sender_name: senderName,
            sender_type: 'agent',
            message_text: row.reply_text,
            direction: 'outbound',
            email_subject: row.subject || null,
            attachments: row.attachments ?? null,
            replied: true,
            reply_required: false,
            timestamp: sentAt,
            received_at: sentAt,
          })
          if (msgErr) messageInsertError = msgErr.message
        } catch (insertErr) {
          messageInsertError = insertErr instanceof Error ? insertErr.message : 'unknown insert failure'
        }

        if (messageInsertError) {
          await admin
            .from('pending_sends')
            .update({ status: 'sent', sent_at: sentAt, error: `message_insert_failed: ${messageInsertError}` })
            .eq('id', row.id)
          await logError(
            'system',
            'dispatch.pending_message_insert_failed',
            'Pending send dispatched but timeline row insert failed',
            {
              request_id: requestId,
              pending_id: row.id,
              account_id: row.account_id,
              conversation_id: row.conversation_id,
              channel: row.channel,
              error: messageInsertError,
            }
          )
          pendingDispatched++
          pendingErrors.push({ id: row.id, error: `sent_but_no_timeline: ${messageInsertError}` })
          continue
        }

        await admin
          .from('pending_sends')
          .update({ status: 'sent', sent_at: sentAt, error: null })
          .eq('id', row.id)

        // Clear inbound replied flags so the conversation exits "needs reply".
        await admin
          .from('messages')
          .update({ replied: true })
          .eq('conversation_id', row.conversation_id)
          .eq('direction', 'inbound')
          .eq('replied', false)

        pendingDispatched++
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Pending dispatch failed'
        pendingErrors.push({ id: row.id, error: message })
        pendingFailed++
        await admin
          .from('pending_sends')
          .update({ status: 'failed', error: message })
          .eq('id', row.id)
        // Tell the agent who queued it — fire-and-forget, never blocks the loop.
        void notifySenderOfFailure(admin, {
          createdBy: row.created_by,
          conversationId: row.conversation_id,
          channel: row.channel,
          toAddress: row.to_address,
          error: message,
          kind: 'pending_send',
          requestId,
        })
        // Mirror the scheduled-messages path: also land it in the agent's bell.
        if (row.created_by) {
          void createNotification(
            {
              user_id: row.created_by,
              type: 'system_alert',
              title: 'Your reply failed to send',
              body: `To ${row.to_address || `the ${row.channel} recipient`}: ${message.slice(0, 200)}`,
              link: `/conversations/${row.conversation_id}`,
              conversation_id: row.conversation_id,
            },
            admin
          )
        }
      }
    }
  }

  const durationMs = Date.now() - startedAt
  logInfo('system', 'dispatch_scheduled_end', 'dispatch-scheduled cron finished', {
    request_id: requestId,
    dispatched,
    failed,
    skipped,
    errors_count: errors.length,
    pending_dispatched: pendingDispatched,
    pending_failed: pendingFailed,
    pending_skipped: pendingSkipped,
    pending_errors_count: pendingErrors.length,
    duration_ms: durationMs,
  })

  // ── Operational metrics ────────────────────────────────────────────
  // `fetched` here is the total number of messages we *attempted* to
  // dispatch (scheduled + pending undo-window). Per-row failures count
  // toward the errors counter; the cron run itself is "successful" if it
  // completed without an unhandled exception.
  const totalDispatched = dispatched + pendingDispatched
  const totalFailed = failed + pendingFailed
  recordMetric('cron.dispatch_scheduled.duration_ms', durationMs, { success: true }, requestId)
  recordMetric('cron.dispatch_scheduled.fetched', totalDispatched, undefined, requestId)
  if (totalFailed > 0) {
    recordMetric('cron.dispatch_scheduled.errors', totalFailed, { stage: 'per_row' }, requestId)
  }

  return NextResponse.json({
    summary: {
      dispatched,
      failed,
      skipped,
      errors,
      pending_sends: {
        dispatched: pendingDispatched,
        failed: pendingFailed,
        skipped: pendingSkipped,
        errors: pendingErrors,
      },
    },
    request_id: requestId,
  })
}

export const POST = GET
