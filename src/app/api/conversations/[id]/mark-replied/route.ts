/**
 * POST /api/conversations/[id]/mark-replied
 *
 * Marks a conversation's INBOUND messages as replied (`replied = true`,
 * `reply_required = false`) so the thread leaves the pending / SLA pipeline.
 * Optionally clears the spam flag (`is_spam = false`) — used by the inbox
 * "Archive" action on the spam / newsletter views so archived junk doesn't
 * reappear there.
 *
 * Body shape:
 *   { clear_spam?: boolean }   // default false
 *
 * Auth gate (identical to /status and /snooze):
 *   - authenticated
 *   - has access to the conversation's account (verifyAccountAccess)
 *   - holds `action:message.send`
 *   - can see the conversation's channel (channel segmentation)
 *
 * This route exists to close an intra-tenant RBAC gap: the inbox bulk
 * "Mark Replied" / "Archive" / "Resolve" buttons used to write the `messages`
 * table directly via the browser Supabase client. The conversations/messages
 * UPDATE RLS is intentionally only company+channel scoped, so a within-company
 * user whom an admin restricted (e.g. denied `message.send` via a per-user
 * override in /admin/roles) could still mutate. Routing through this gated
 * route enforces the same server-side check the rest of the conversation
 * mutations use, and records an audit_log entry.
 */

import { NextResponse } from 'next/server'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { verifyAccountAccess } from '@/lib/api-helpers'
import { userIdCan } from '@/lib/permissions/server'
import { userCanAccessConversationChannel } from '@/lib/permissions/channel-access'

interface PostBody {
  clear_spam?: boolean
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: conversationId } = await context.params
    if (!conversationId) {
      return NextResponse.json({ error: 'Missing conversation id' }, { status: 400 })
    }

    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await request.json().catch(() => ({}))) as PostBody
    const clearSpam = body.clear_spam === true

    const admin = await createServiceRoleClient()

    const { data: conv, error: convErr } = await admin
      .from('conversations')
      .select('id, account_id, channel')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const allowed = await verifyAccountAccess(user.id, conv.account_id)
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }

    // RBAC: marking messages replied is an agent write action.
    if (!(await userIdCan(user.id, 'action:message.send'))) {
      return NextResponse.json({ error: 'Forbidden: missing permission' }, { status: 403 })
    }
    // Channel segmentation: respect the caller's channel grants (service-role bypasses RLS).
    if (!(await userCanAccessConversationChannel(user.id, conv.channel))) {
      return NextResponse.json({ error: 'Forbidden: missing channel permission' }, { status: 403 })
    }

    // Mark every inbound message of the conversation as handled. Mirrors the
    // /api/send write semantics (whole conversation, not a single message).
    const update: Record<string, unknown> = { replied: true, reply_required: false }
    if (clearSpam) update.is_spam = false

    const { data: updated, error: updateErr } = await admin
      .from('messages')
      .update(update)
      .eq('conversation_id', conversationId)
      .eq('direction', 'inbound')
      .select('id')
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    // Audit (best-effort). Surfaces on the activity timeline.
    try {
      await admin.from('audit_log').insert({
        user_id: user.id,
        action: 'conversation.messages_replied',
        entity_type: 'conversation',
        entity_id: conversationId,
        details: {
          account_id: conv.account_id,
          messages_updated: updated?.length ?? 0,
          cleared_spam: clearSpam,
          summary: clearSpam ? 'Archived (marked replied)' : 'Marked replied',
        },
      })
    } catch {
      /* non-critical */
    }

    return NextResponse.json({ success: true, updated: updated?.length ?? 0 })
  } catch (err) {
    console.error('Mark-replied POST error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
