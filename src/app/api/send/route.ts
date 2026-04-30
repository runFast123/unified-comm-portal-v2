import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { sendEmail, sendTeams, sendWhatsApp } from '@/lib/channel-sender'
import { checkRateLimit } from '@/lib/api-helpers'
import { getRequestId } from '@/lib/request-id'
import { logError, logInfo } from '@/lib/logger'

type Channel = 'email' | 'teams' | 'whatsapp'

interface OutboundAttachment {
  path: string
  filename: string
  contentType?: string
  size?: number
}

interface SendBody {
  channel: Channel
  account_id: string
  conversation_id: string
  reply_text: string
  to?: string | null
  subject?: string | null
  teams_chat_id?: string | null
  /** Optional outbound attachments. Email-only for this pass. */
  attachments?: OutboundAttachment[]
  /**
   * Undo-Send window in milliseconds. When > 0, the request inserts a row
   * into `pending_sends` with `send_at = now() + delay_ms` and returns
   * `{ pending_id, send_at }` instead of dispatching immediately. The
   * dispatch-scheduled cron picks up the row when due. Defaults to 0
   * (immediate send) for backwards compatibility with existing callers.
   */
  delay_ms?: number
}

const DUP_WINDOW_MS = 15_000

// Cap the undo window so a malicious / buggy client can't squat on a row
// for an hour. 60s is plenty for any reasonable Gmail-style undo UI.
const MAX_DELAY_MS = 60_000

export async function POST(request: Request) {
  const requestId = await getRequestId()
  const startedAt = Date.now()
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 })

    const body = (await request.json()) as SendBody
    const { channel, account_id, conversation_id, reply_text } = body

    if (!channel || !account_id || !conversation_id || !reply_text) {
      return NextResponse.json({ error: 'Missing required fields', request_id: requestId }, { status: 400 })
    }
    if (!(['email', 'teams', 'whatsapp'] as const).includes(channel)) {
      return NextResponse.json({ error: `Unsupported channel: ${channel}`, request_id: requestId }, { status: 400 })
    }

    const admin = await createServiceRoleClient()

    // Account scope: admins can send for any account; others must match account_id.
    const { data: profile } = await admin
      .from('users')
      .select('role, account_id')
      .eq('id', user.id)
      .maybeSingle()
    if (!profile) return NextResponse.json({ error: 'User profile not found', request_id: requestId }, { status: 403 })
    const isAdmin = profile.role === 'admin'
    if (!isAdmin && profile.account_id !== account_id) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch', request_id: requestId }, { status: 403 })
    }

    // Confirm the conversation actually belongs to this account.
    const { data: conv } = await admin
      .from('conversations')
      .select('id, account_id, channel')
      .eq('id', conversation_id)
      .maybeSingle()
    if (!conv) return NextResponse.json({ error: 'Conversation not found', request_id: requestId }, { status: 404 })
    if (conv.account_id !== account_id) {
      return NextResponse.json({ error: 'Conversation does not belong to this account', request_id: requestId }, { status: 403 })
    }
    if (conv.channel !== channel) {
      return NextResponse.json({ error: 'Channel mismatch with conversation', request_id: requestId }, { status: 400 })
    }

    if (!(await checkRateLimit(`send:${channel}:${account_id}`, 30, 60))) {
      return NextResponse.json({ error: 'Rate limit exceeded', request_id: requestId }, { status: 429 })
    }

    // Idempotency: if an identical outbound message was sent in the last 15s, short-circuit.
    const since = new Date(Date.now() - DUP_WINDOW_MS).toISOString()
    const { data: dup } = await admin
      .from('messages')
      .select('id')
      .eq('conversation_id', conversation_id)
      .eq('direction', 'outbound')
      .eq('message_text', reply_text)
      .gte('received_at', since)
      .limit(1)
      .maybeSingle()
    if (dup) {
      return NextResponse.json({ success: true, deduped: true, provider_message_id: null })
    }

    // Normalize + sanity-check any inbound attachments. Each path must
    // start with the caller's user id (matches upload route invariant).
    const attachments: OutboundAttachment[] = Array.isArray(body.attachments)
      ? body.attachments.filter(
          (a): a is OutboundAttachment =>
            !!a && typeof a.path === 'string' && typeof a.filename === 'string'
        )
      : []
    for (const a of attachments) {
      if (!a.path.startsWith(`${user.id}/`)) {
        return NextResponse.json(
          { error: 'Invalid attachment path (ownership mismatch)', request_id: requestId },
          { status: 403 }
        )
      }
    }

    // ── Undo-Send branch ───────────────────────────────────────────────
    // When the UI passes `delay_ms > 0`, we don't actually call the
    // channel sender here. Instead we write a `pending_sends` row that
    // the dispatch-scheduled cron will pick up after `send_at` passes.
    // Until then the user can DELETE /api/send/cancel to flip it to
    // 'cancelled' and prevent the send entirely.
    const delayMs = Number.isFinite(body.delay_ms) ? Math.max(0, Math.floor(body.delay_ms as number)) : 0
    if (delayMs > 0) {
      if (delayMs > MAX_DELAY_MS) {
        return NextResponse.json(
          { error: `delay_ms exceeds max of ${MAX_DELAY_MS}`, request_id: requestId },
          { status: 400 }
        )
      }
      const sendAtIso = new Date(Date.now() + delayMs).toISOString()
      const { data: pendingRow, error: pendingErr } = await admin
        .from('pending_sends')
        .insert({
          conversation_id,
          account_id,
          channel,
          reply_text,
          to_address: body.to ?? null,
          subject: body.subject ?? null,
          teams_chat_id: body.teams_chat_id ?? null,
          attachments: attachments.length > 0 ? { attachments } : null,
          created_by: user.id,
          send_at: sendAtIso,
          status: 'pending',
        })
        .select('id, send_at')
        .single()

      if (pendingErr || !pendingRow) {
        logError('system', 'send_pending_insert_failed', pendingErr?.message || 'insert returned no row', {
          request_id: requestId,
          account_id,
          user_id: user.id,
          channel,
          conversation_id,
        })
        return NextResponse.json(
          { error: pendingErr?.message || 'Failed to enqueue pending send', request_id: requestId },
          { status: 500 }
        )
      }

      logInfo('system', 'send_pending_enqueued', `Enqueued ${channel} reply with ${delayMs}ms undo window`, {
        request_id: requestId,
        account_id,
        user_id: user.id,
        conversation_id,
        pending_id: pendingRow.id,
      })

      return NextResponse.json({
        success: true,
        pending: true,
        pending_id: pendingRow.id,
        send_at: pendingRow.send_at,
        attachments: channel === 'email' ? attachments : [],
        request_id: requestId,
      })
    }

    let result
    if (channel === 'email') {
      if (!body.to) return NextResponse.json({ error: 'Missing recipient email', request_id: requestId }, { status: 400 })
      result = await sendEmail({
        accountId: account_id,
        to: body.to,
        subject: body.subject || 'Re: Your inquiry',
        body: reply_text,
        attachments: attachments.length > 0
          ? attachments.map((a) => ({ path: a.path, filename: a.filename, contentType: a.contentType }))
          : undefined,
      })
    } else if (channel === 'teams') {
      const chatId = body.teams_chat_id
      if (!chatId) return NextResponse.json({ error: 'Missing teams_chat_id', request_id: requestId }, { status: 400 })
      result = await sendTeams({ accountId: account_id, chatId, body: reply_text })
    } else {
      if (!body.to) return NextResponse.json({ error: 'Missing recipient phone', request_id: requestId }, { status: 400 })
      result = await sendWhatsApp({ accountId: account_id, toPhone: body.to, body: reply_text })
    }

    if (!result.ok) {
      logError('system', 'send_failed', result.error || 'unknown send failure', {
        request_id: requestId,
        account_id,
        user_id: user.id,
        channel,
        conversation_id,
      })
      return NextResponse.json({ error: result.error, request_id: requestId }, { status: 502 })
    }

    // Mark inbound messages as replied
    await admin
      .from('messages')
      .update({ replied: true })
      .eq('conversation_id', conversation_id)
      .eq('direction', 'inbound')
      .eq('replied', false)

    // Audit. request_id stays in `details` so we can grep audit_log for
    // the same correlation id surfaced in stdout / Sentry.
    await admin.from('audit_log').insert({
      user_id: user.id,
      action: 'channel.send',
      entity_type: 'conversation',
      entity_id: conversation_id,
      details: {
        channel,
        account_id,
        provider_message_id: result.provider_message_id ?? null,
        request_id: requestId,
      },
    })

    logInfo('system', 'send_ok', `Sent ${channel} reply`, {
      request_id: requestId,
      account_id,
      user_id: user.id,
      conversation_id,
      duration_ms: Date.now() - startedAt,
    })

    return NextResponse.json({
      success: true,
      provider_message_id: result.provider_message_id ?? null,
      // Echo normalized attachments so the client can mirror them into the
      // outbound `messages` row it inserts after a successful send. Only
      // email actually attached them; other channels receive an empty array.
      attachments: channel === 'email' ? attachments : [],
      request_id: requestId,
    })
  } catch (err) {
    logError('system', 'send_error', err instanceof Error ? err.message : 'Internal error', {
      request_id: requestId,
      duration_ms: Date.now() - startedAt,
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error', request_id: requestId },
      { status: 500 }
    )
  }
}
