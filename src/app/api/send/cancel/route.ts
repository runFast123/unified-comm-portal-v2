import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getRequestId } from '@/lib/request-id'
import { logError, logInfo } from '@/lib/logger'

interface CancelBody {
  pending_id: string
}

/**
 * DELETE /api/send/cancel
 *
 * Cancels a pending Undo-Send row. The caller must be the user who
 * created it AND the row must still be in 'pending' status. If the
 * cron has already moved the row to 'sending' / 'sent' / 'failed',
 * we return 410 Gone so the UI can show "too late".
 *
 * Soft-delete: we flip status to 'cancelled' rather than removing the
 * row, so the audit trail of attempted+aborted sends stays intact.
 */
export async function DELETE(request: Request) {
  const requestId = await getRequestId()
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 })
    }

    let body: CancelBody
    try {
      body = (await request.json()) as CancelBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body', request_id: requestId }, { status: 400 })
    }
    if (!body?.pending_id || typeof body.pending_id !== 'string') {
      return NextResponse.json({ error: 'Missing pending_id', request_id: requestId }, { status: 400 })
    }

    const admin = await createServiceRoleClient()

    // Look up the row to surface a clean 404/410/403 error class. We
    // could rely on the conditional UPDATE alone, but that hides the
    // distinction between "doesn't exist", "not yours", and "already
    // sent/sending" which the UI wants to render differently.
    const { data: row, error: lookupErr } = await admin
      .from('pending_sends')
      .select('id, created_by, status')
      .eq('id', body.pending_id)
      .maybeSingle()

    if (lookupErr) {
      logError('system', 'send_cancel_lookup_failed', lookupErr.message, {
        request_id: requestId,
        pending_id: body.pending_id,
        user_id: user.id,
      })
      return NextResponse.json({ error: lookupErr.message, request_id: requestId }, { status: 500 })
    }
    if (!row) {
      return NextResponse.json({ error: 'Pending send not found', request_id: requestId }, { status: 404 })
    }
    if (row.created_by !== user.id) {
      // Treat ownership mismatch as 403 — a 404 here would leak whether
      // the id exists for some other user.
      return NextResponse.json({ error: 'Forbidden', request_id: requestId }, { status: 403 })
    }
    if (row.status !== 'pending') {
      // Cron already started/finished it. 410 Gone is the precise code:
      // the resource existed but has moved past the cancellable state.
      return NextResponse.json(
        { error: `Cannot cancel — status is '${row.status}'`, status: row.status, request_id: requestId },
        { status: 410 }
      )
    }

    // Compare-and-set on status — guards against the race where the cron
    // picks up the row between our lookup and our UPDATE.
    const { data: updated, error: updateErr } = await admin
      .from('pending_sends')
      .update({ status: 'cancelled' })
      .eq('id', body.pending_id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()

    if (updateErr) {
      logError('system', 'send_cancel_update_failed', updateErr.message, {
        request_id: requestId,
        pending_id: body.pending_id,
        user_id: user.id,
      })
      return NextResponse.json({ error: updateErr.message, request_id: requestId }, { status: 500 })
    }
    if (!updated) {
      // Lost the race with the cron — row is no longer pending.
      return NextResponse.json(
        { error: 'Cannot cancel — message was already picked up for sending', request_id: requestId },
        { status: 410 }
      )
    }

    logInfo('system', 'send_cancel_ok', 'Pending send cancelled', {
      request_id: requestId,
      pending_id: body.pending_id,
      user_id: user.id,
    })

    return NextResponse.json({ success: true, pending_id: body.pending_id, request_id: requestId })
  } catch (err) {
    logError('system', 'send_cancel_error', err instanceof Error ? err.message : 'Internal error', {
      request_id: requestId,
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error', request_id: requestId },
      { status: 500 }
    )
  }
}
