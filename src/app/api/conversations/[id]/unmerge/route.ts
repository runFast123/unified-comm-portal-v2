// POST /api/conversations/[id]/unmerge
//
// Body: { secondary_conversation_id: string }
//
// Reverses a previous merge. Looks up the most recent active audit row for the
// pair, moves only the message ids it recorded back onto the secondary, and
// clears the secondary's merged_* fields.

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { verifyAccountAccess, checkRateLimit } from '@/lib/api-helpers'
import { unmergeConversations } from '@/lib/conversation-merge'
import { getCurrentUser, isSupervisor } from '@/lib/auth'

interface Body {
  secondary_conversation_id?: string
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: primaryId } = await context.params
    if (!primaryId) {
      return NextResponse.json({ error: 'Missing conversation id' }, { status: 400 })
    }

    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!(await checkRateLimit(`unmerge:${user.id}`, 30, 60))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    const body = (await request.json().catch(() => ({}))) as Body
    const secondaryId = typeof body.secondary_conversation_id === 'string'
      ? body.secondary_conversation_id
      : ''
    if (!secondaryId) {
      return NextResponse.json(
        { error: 'secondary_conversation_id is required' },
        { status: 400 }
      )
    }

    const admin = await createServiceRoleClient()

    const { data: convs, error: convsErr } = await admin
      .from('conversations')
      .select('id, account_id')
      .in('id', [primaryId, secondaryId])
    if (convsErr) {
      return NextResponse.json({ error: convsErr.message }, { status: 500 })
    }
    if (!convs || convs.length !== 2) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    for (const c of convs) {
      const allowed = await verifyAccountAccess(user.id, c.account_id)
      if (!allowed) {
        return NextResponse.json(
          { error: 'Forbidden: account scope mismatch' },
          { status: 403 }
        )
      }
    }

    // ── Phase 2: role-tier enforcement ──
    // Unmerge is destructive (moves messages back, mutates audit row). Require supervisor+.
    const callerProfile = await getCurrentUser(user.id)
    if (!isSupervisor(callerProfile?.role ?? null)) {
      return NextResponse.json(
        { error: 'Only supervisors and admins can unmerge conversations' },
        { status: 403 }
      )
    }

    let result
    try {
      result = await unmergeConversations(admin, primaryId, secondaryId, user.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unmerge failed'
      if (/no active merge|no longer exists/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 400 })
      }
      return NextResponse.json({ error: message }, { status: 500 })
    }

    try {
      await admin.from('audit_log').insert({
        user_id: user.id,
        action: 'conversation.unmerged',
        entity_type: 'conversation',
        entity_id: primaryId,
        details: {
          primary_conversation_id: primaryId,
          secondary_conversation_id: secondaryId,
          merge_audit_id: result.audit_id,
          message_count: result.message_ids.length,
        },
      })
    } catch {
      /* non-critical */
    }

    return NextResponse.json({ success: true, unmerge: result })
  } catch (err) {
    console.error('unmerge POST error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
