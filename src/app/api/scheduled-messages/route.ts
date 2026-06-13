import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { checkRateLimit, verifyAccountAccess } from '@/lib/api-helpers'
import { getAllowedAccountIds, isSuperAdmin } from '@/lib/auth'
import { isChannel, getChannel } from '@/lib/channels/registry'
import { userIdCan } from '@/lib/permissions/server'

// Reject anything scheduled more than a year out. Keeps runaway/malicious
// payloads from squatting on the scheduled-messages table forever.
const MAX_SCHEDULE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000

type Channel = 'email' | 'teams' | 'whatsapp'

interface CreateBody {
  conversation_id: string
  channel: Channel
  reply_text: string
  to?: string | null
  subject?: string | null
  teams_chat_id?: string | null
  scheduled_for: string
  attachments?: unknown
}

/**
 * POST /api/scheduled-messages
 * Creates a scheduled message that the cron dispatcher will send at `scheduled_for`.
 *
 * Security: session-auth + account scope. Admins can schedule on any account; other
 * users must match the conversation's account_id (mirrors /api/send's pattern).
 */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Rate limit: 50 scheduled messages per 5 minutes per user. Cheap to
    // enforce and blunts abuse even though the auth check above already
    // requires a valid session.
    if (!(await checkRateLimit(`scheduled:create:${user.id}`, 50, 300))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    const body = (await request.json()) as CreateBody
    const { conversation_id, channel, reply_text, scheduled_for } = body

    if (!conversation_id || !channel || !reply_text || !scheduled_for) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    if (!isChannel(channel)) {
      return NextResponse.json({ error: `Unsupported channel: ${channel}` }, { status: 400 })
    }

    const scheduledAt = new Date(scheduled_for)
    if (Number.isNaN(scheduledAt.getTime())) {
      return NextResponse.json({ error: 'Invalid scheduled_for (must be ISO datetime)' }, { status: 400 })
    }
    // Must be in the future. One-minute floor guards clock skew and misclicks.
    if (scheduledAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'scheduled_for must be in the future' }, { status: 400 })
    }
    // Upper bound: reject anything more than a year out.
    if (scheduledAt.getTime() > Date.now() + MAX_SCHEDULE_HORIZON_MS) {
      return NextResponse.json(
        { error: 'scheduled_for must be within 365 days' },
        { status: 400 }
      )
    }

    const admin = await createServiceRoleClient()

    // Account scope: super_admin bypasses; everyone else (company admins,
    // company members, legacy single-account users) must have access to the
    // conversation's account via verifyAccountAccess().
    const { data: profile } = await admin
      .from('users')
      .select('role, account_id')
      .eq('id', user.id)
      .maybeSingle()
    if (!profile) return NextResponse.json({ error: 'User profile not found' }, { status: 403 })

    const { data: conv } = await admin
      .from('conversations')
      .select('id, account_id, channel')
      .eq('id', conversation_id)
      .maybeSingle()
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    const hasAccountAccess = await verifyAccountAccess(user.id, conv.account_id)
    if (!hasAccountAccess) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }
    if (conv.channel !== channel) {
      return NextResponse.json({ error: 'Channel mismatch with conversation' }, { status: 400 })
    }
    // RBAC: scheduling a message is a deferred send — same gate as /api/send.
    if (!(await userIdCan(user.id, 'action:message.send'))) {
      return NextResponse.json({ error: 'Forbidden: missing permission' }, { status: 403 })
    }
    if (!(await userIdCan(user.id, `channel:${channel}`))) {
      return NextResponse.json({ error: 'Forbidden: channel not allowed' }, { status: 403 })
    }

    // Channel-specific recipient validation — registry-driven so EVERY channel
    // is covered: chat-id channels (teams/telegram/messenger/instagram) need
    // teams_chat_id; email/whatsapp/sms carry the recipient in `to`.
    const recipientField = getChannel(channel)?.recipientField
    const hasRecipient = recipientField === 'teams_chat_id' ? !!body.teams_chat_id : !!body.to
    if (!hasRecipient) {
      return NextResponse.json({ error: `Missing recipient for ${channel}` }, { status: 400 })
    }

    const { data: row, error } = await admin
      .from('scheduled_messages')
      .insert({
        conversation_id,
        account_id: conv.account_id,
        channel,
        reply_text,
        to_address: body.to ?? null,
        subject: body.subject ?? null,
        teams_chat_id: body.teams_chat_id ?? null,
        attachments: body.attachments ?? null,
        scheduled_for: scheduledAt.toISOString(),
        status: 'pending',
        created_by: user.id,
      })
      .select('*')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, scheduled: row })
  } catch (err) {
    console.error('Scheduled-messages POST error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}

/** Truncated body preview for failed-send banners. */
function bodyPreview(text: string | null): string {
  const t = text || ''
  return t.length > 140 ? t.slice(0, 140).trimEnd() + '…' : t
}

/**
 * GET /api/scheduled-messages
 * Returns pending scheduled messages the caller can see. Admins see all; regular
 * users see their own account. Optional ?conversation_id=... filter.
 *
 * With ?conversation_id=...&include=failed the response additionally carries a
 * `failed` array — that conversation's FAILED pending_sends + scheduled_messages
 * rows (id, kind, body preview, error, failed_at) so the UI can surface replies
 * that died after the undo window. Same tenant scoping as the pending list.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const admin = await createServiceRoleClient()
    const { data: profile } = await admin
      .from('users')
      .select('role, account_id')
      .eq('id', user.id)
      .maybeSingle()
    if (!profile) return NextResponse.json({ error: 'User profile not found' }, { status: 403 })

    const url = new URL(request.url)
    const conversationId = url.searchParams.get('conversation_id')
    const includeFailed = url.searchParams.get('include') === 'failed' && !!conversationId

    // super_admin sees everything (allowedIds === null); everyone else is
    // scoped to the union of accounts in their company (or their single
    // account_id for legacy users with no company_id).
    let allowedIds: string[] | null = null
    if (!isSuperAdmin(profile.role)) {
      const allowed = await getAllowedAccountIds(user.id)
      allowedIds = allowed ? Array.from(allowed) : []
      if (allowedIds.length === 0) {
        return NextResponse.json(includeFailed ? { items: [], failed: [] } : { items: [] })
      }
    }

    let query = admin
      .from('scheduled_messages')
      .select('*')
      .eq('status', 'pending')
      .order('scheduled_for', { ascending: true })
    if (allowedIds) query = query.in('account_id', allowedIds)
    if (conversationId) {
      query = query.eq('conversation_id', conversationId)
    }

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    if (!includeFailed) return NextResponse.json({ items: data ?? [] })

    // ── Failed-send reader ────────────────────────────────────────────
    // Both queues, same account scope as the pending list above.
    let failedScheduledQ = admin
      .from('scheduled_messages')
      .select('id, channel, reply_text, error, scheduled_for, to_address')
      .eq('status', 'failed')
      .eq('conversation_id', conversationId)
    if (allowedIds) failedScheduledQ = failedScheduledQ.in('account_id', allowedIds)

    let failedPendingQ = admin
      .from('pending_sends')
      .select('id, channel, reply_text, error, send_at, to_address')
      .eq('status', 'failed')
      .eq('conversation_id', conversationId)
    if (allowedIds) failedPendingQ = failedPendingQ.in('account_id', allowedIds)

    const [failedScheduled, failedPending] = await Promise.all([failedScheduledQ, failedPendingQ])
    if (failedScheduled.error) {
      return NextResponse.json({ error: failedScheduled.error.message }, { status: 500 })
    }
    if (failedPending.error) {
      return NextResponse.json({ error: failedPending.error.message }, { status: 500 })
    }

    // Neither table stores a failure timestamp; the dispatcher attempts a row
    // within ~60s of its due time, so the due time is the closest proxy.
    const failed = [
      ...(failedScheduled.data ?? []).map((r) => ({
        id: r.id as string,
        kind: 'scheduled' as const,
        channel: r.channel as string,
        body_preview: bodyPreview(r.reply_text as string | null),
        error: (r.error as string | null) ?? null,
        failed_at: r.scheduled_for as string,
        to_address: (r.to_address as string | null) ?? null,
      })),
      ...(failedPending.data ?? []).map((r) => ({
        id: r.id as string,
        kind: 'pending_send' as const,
        channel: r.channel as string,
        body_preview: bodyPreview(r.reply_text as string | null),
        error: (r.error as string | null) ?? null,
        failed_at: r.send_at as string,
        to_address: (r.to_address as string | null) ?? null,
      })),
    ].sort((a, b) => new Date(b.failed_at).getTime() - new Date(a.failed_at).getTime())

    return NextResponse.json({ items: data ?? [], failed })
  } catch (err) {
    console.error('Scheduled-messages GET error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
