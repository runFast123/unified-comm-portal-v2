import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { sendEmail, sendTeams, sendWhatsApp } from '@/lib/channel-sender'
import { validateWebhookSecret } from '@/lib/api-helpers'
import { logError, logInfo } from '@/lib/logger'
import { getRequestId } from '@/lib/request-id'

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
    .select('id, conversation_id, account_id, channel, reply_text, to_address, subject, teams_chat_id, attachments, scheduled_for')
    .eq('status', 'pending')
    .lte('scheduled_for', nowIso)
    .order('scheduled_for', { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    logError('system', 'dispatch_scheduled_query_error', error.message, { request_id: requestId })
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
        result = await sendEmail({
          accountId: row.account_id,
          to: row.to_address,
          subject: row.subject || 'Re: Your inquiry',
          body: row.reply_text,
        })
      } else if (row.channel === 'teams') {
        if (!row.teams_chat_id) {
          throw new Error('Missing teams_chat_id on scheduled row')
        }
        result = await sendTeams({
          accountId: row.account_id,
          chatId: row.teams_chat_id,
          body: row.reply_text,
        })
      } else {
        if (!row.to_address) {
          throw new Error('Missing recipient phone on scheduled row')
        }
        result = await sendWhatsApp({
          accountId: row.account_id,
          toPhone: row.to_address,
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
    .select('id, conversation_id, account_id, channel, reply_text, to_address, subject, teams_chat_id, attachments, send_at')
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
          result = await sendEmail({
            accountId: row.account_id,
            to: row.to_address,
            subject: row.subject || 'Re: Your inquiry',
            body: row.reply_text,
            attachments: atts.length > 0
              ? atts.map((a) => ({ path: a.path, filename: a.filename, contentType: a.contentType }))
              : undefined,
          })
        } else if (row.channel === 'teams') {
          if (!row.teams_chat_id) throw new Error('Missing teams_chat_id on pending row')
          result = await sendTeams({
            accountId: row.account_id,
            chatId: row.teams_chat_id,
            body: row.reply_text,
          })
        } else {
          if (!row.to_address) throw new Error('Missing recipient phone on pending row')
          result = await sendWhatsApp({
            accountId: row.account_id,
            toPhone: row.to_address,
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
      }
    }
  }

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
    duration_ms: Date.now() - startedAt,
  })

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
