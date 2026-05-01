/**
 * POST /api/conversations/[id]/assign
 *
 * Assigns or unassigns a conversation. Records the change in audit_log so
 * it shows up on the activity timeline.
 *
 * Body shape:
 *   { user_id: string | null }   // null = unassign
 *
 * Auth: must be authenticated and have access to the conversation's account.
 */

import { NextResponse } from 'next/server'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { verifyAccountAccess } from '@/lib/api-helpers'

interface PostBody {
  user_id?: string | null
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
    if (body.user_id !== null && typeof body.user_id !== 'string') {
      return NextResponse.json(
        { error: '`user_id` must be a string (assignee user id) or null (unassign)' },
        { status: 400 }
      )
    }

    const admin = await createServiceRoleClient()

    const { data: conv, error: convErr } = await admin
      .from('conversations')
      .select('id, account_id, assigned_to')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const allowed = await verifyAccountAccess(user.id, conv.account_id)
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }

    // ── H6 fix: validate assignee belongs to the same company ──
    // Without this guard, any authenticated user could write any UUID into
    // `assigned_to` (orphan assignments, audit-log noise, surprise Slack
    // notifications to people in unrelated companies).
    let assigneeName: string | null = null
    if (body.user_id) {
      const { data: assignee } = await admin
        .from('users')
        .select('full_name, email, company_id, role')
        .eq('id', body.user_id)
        .maybeSingle()
      if (!assignee) {
        return NextResponse.json(
          { error: 'Assignee user not found' },
          { status: 422 }
        )
      }
      // Resolve the conversation's company via its account
      const { data: convAccount } = await admin
        .from('accounts')
        .select('company_id')
        .eq('id', conv.account_id)
        .maybeSingle()
      const convCompanyId = convAccount?.company_id ?? null

      // Caller's role determines the bypass: super_admin can assign across
      // companies (rare, intentional); everyone else requires the assignee
      // to belong to the conversation's company.
      const { data: callerProfile } = await admin
        .from('users')
        .select('role')
        .eq('id', user.id)
        .maybeSingle()
      const callerRole = (callerProfile?.role as string | undefined) ?? null
      const isSuperAdmin = callerRole === 'super_admin'

      if (!isSuperAdmin) {
        if (convCompanyId == null || assignee.company_id == null) {
          return NextResponse.json(
            { error: 'Cannot assign: missing company linkage' },
            { status: 422 }
          )
        }
        if (assignee.company_id !== convCompanyId) {
          return NextResponse.json(
            { error: 'Assignee must belong to the same company as the conversation' },
            { status: 422 }
          )
        }
      }
      assigneeName = assignee.full_name || assignee.email || null
    }

    const { error: updateErr } = await admin
      .from('conversations')
      .update({ assigned_to: body.user_id ?? null })
      .eq('id', conversationId)
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    if (body.user_id !== conv.assigned_to) {
      try {
        const isUnassign = body.user_id == null
        await admin.from('audit_log').insert({
          user_id: user.id,
          action: isUnassign ? 'conversation.unassigned' : 'conversation.assigned',
          entity_type: 'conversation',
          entity_id: conversationId,
          details: {
            previous_assignee_id: conv.assigned_to,
            new_assignee_id: body.user_id ?? null,
            new_assignee_name: assigneeName,
            account_id: conv.account_id,
            summary: isUnassign
              ? 'Unassigned'
              : `Assigned to ${assigneeName || body.user_id}`,
          },
        })
      } catch {
        /* non-critical */
      }
    }

    return NextResponse.json({ success: true, assigned_to: body.user_id ?? null })
  } catch (err) {
    console.error('Assign POST error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
