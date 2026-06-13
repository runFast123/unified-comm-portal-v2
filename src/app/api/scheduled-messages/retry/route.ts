import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { checkRateLimit, verifyAccountAccess } from '@/lib/api-helpers'
import { userIdCan } from '@/lib/permissions/server'

interface RetryBody {
  id: string
  kind: 'pending_send' | 'scheduled'
  /** 'retry' re-queues the failed row; 'dismiss' hides it from the banner. */
  op?: 'retry' | 'dismiss'
}

/**
 * POST /api/scheduled-messages/retry
 * Acts on a FAILED outbound row (a reply the dispatch cron couldn't deliver):
 *   - op 'retry' (default): flips it back to status='pending' with the
 *     send time = now and the error cleared, so the cron re-dispatches it
 *     on its next run (~60s).
 *   - op 'dismiss': flips it to status='dismissed' so the failure banner
 *     stops showing it. History is preserved (no delete).
 *
 * Security: session-auth + account scope (verifyAccountAccess on the row's
 * account_id) + the same RBAC gate as /api/send — retrying IS a send, and
 * dismissing hides a delivery failure from the rest of the team.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: RetryBody
    try {
      body = (await request.json()) as RetryBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const id = body?.id
    const kind = body?.kind
    const op = body?.op ?? 'retry'
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 })
    }
    if (kind !== 'pending_send' && kind !== 'scheduled') {
      return NextResponse.json({ error: "kind must be 'pending_send' or 'scheduled'" }, { status: 400 })
    }
    if (op !== 'retry' && op !== 'dismiss') {
      return NextResponse.json({ error: "op must be 'retry' or 'dismiss'" }, { status: 400 })
    }

    if (!(await checkRateLimit(`scheduled:retry:${user.id}`, 30, 300))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    const admin = await createServiceRoleClient()
    const table = kind === 'pending_send' ? 'pending_sends' : 'scheduled_messages'

    const { data: row, error: lookupErr } = await admin
      .from(table)
      .select('id, account_id, status')
      .eq('id', id)
      .maybeSingle()
    if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 })
    if (!row) return NextResponse.json({ error: 'Failed send not found' }, { status: 404 })

    const hasAccountAccess = await verifyAccountAccess(user.id, row.account_id)
    if (!hasAccountAccess) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }
    if (!(await userIdCan(user.id, 'action:message.send'))) {
      return NextResponse.json({ error: 'Forbidden: missing permission' }, { status: 403 })
    }

    if (row.status !== 'failed') {
      return NextResponse.json(
        { error: `Cannot ${op} a message with status='${row.status}'` },
        { status: 400 }
      )
    }

    // pending_sends keys its dispatch time on send_at; scheduled_messages on
    // scheduled_for (matches the cron's `.lte(..., now)` queries).
    const timeField = kind === 'pending_send' ? 'send_at' : 'scheduled_for'
    const update: Record<string, unknown> =
      op === 'dismiss'
        ? { status: 'dismissed' }
        : { status: 'pending', error: null, [timeField]: new Date().toISOString() }

    // Compare-and-set on status='failed' so two agents acting on the same
    // banner can't double-retry (the second request loses the race).
    const { data: updated, error: updateErr } = await admin
      .from(table)
      .update(update)
      .eq('id', id)
      .eq('status', 'failed')
      .select('id')
      .maybeSingle()
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })
    if (!updated) {
      return NextResponse.json(
        { error: 'Row was already retried or dismissed' },
        { status: 409 }
      )
    }

    return NextResponse.json({ success: true, id, kind, op })
  } catch (err) {
    console.error('Scheduled-messages retry error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
