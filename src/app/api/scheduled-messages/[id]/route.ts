import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { verifyAccountAccess } from '@/lib/api-helpers'

/**
 * DELETE /api/scheduled-messages/:id
 * Cancels a pending scheduled message (soft delete — sets status='cancelled'
 * so history is preserved and the cron dispatcher skips it).
 *
 * Security: session-auth, account-scoped. Admins can cancel any; other users
 * must share account_id with the row.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

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

    const { data: row } = await admin
      .from('scheduled_messages')
      .select('id, account_id, status')
      .eq('id', id)
      .maybeSingle()
    if (!row) return NextResponse.json({ error: 'Scheduled message not found' }, { status: 404 })

    // Account scope: super_admin bypasses; everyone else (company admins,
    // company members, legacy single-account users) must have access to the
    // row's account via verifyAccountAccess().
    const hasAccountAccess = await verifyAccountAccess(user.id, row.account_id)
    if (!hasAccountAccess) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }
    if (row.status !== 'pending') {
      return NextResponse.json(
        { error: `Cannot cancel a message with status='${row.status}'` },
        { status: 400 }
      )
    }

    const { error } = await admin
      .from('scheduled_messages')
      .update({ status: 'cancelled' })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Scheduled-messages DELETE error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
