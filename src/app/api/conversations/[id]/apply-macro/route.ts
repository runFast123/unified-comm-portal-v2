/**
 * POST /api/conversations/[id]/apply-macro
 *
 * Applies a saved workflow macro to a conversation in one shot: set status,
 * add tags, assign to a user, set priority. Records the change in audit_log so
 * it shows up on the activity timeline.
 *
 * Body shape:
 *   { macro_id: string }
 *
 * IMPORTANT: this NEVER sends a message — sending always requires explicit
 * human approval in this app. If the macro references a `reply_template_id`,
 * that id is returned so the COMPOSER can insert the template text for the
 * agent to review; nothing is sent server-side.
 *
 * Auth: authenticated + access to the conversation's account (assertAccountAccess).
 * The macro must belong to the SAME company as the conversation.
 */

import { NextResponse } from 'next/server'

import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireUser, assertAccountAccess } from '@/lib/tenant-guard'
import { userIdCan } from '@/lib/permissions/server'
import {
  applyMacro,
  resolveConversationCompanyId,
  MacroValidationError,
  type MacroRecord,
  type ConversationRecord,
} from '@/lib/macros'

interface PostBody {
  macro_id?: unknown
}

const CONVERSATION_COLUMNS =
  'id, account_id, status, secondary_status, priority, tags, assigned_to'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: conversationId } = await context.params
    if (!conversationId) {
      return NextResponse.json({ error: 'Missing conversation id' }, { status: 400 })
    }

    const gate = await requireUser()
    if (!gate.ok) {
      return NextResponse.json({ error: gate.error }, { status: gate.status })
    }
    const { ctx } = gate

    const body = (await request.json().catch(() => ({}))) as PostBody
    const macroId = typeof body.macro_id === 'string' ? body.macro_id.trim() : ''
    if (!macroId) {
      return NextResponse.json({ error: '`macro_id` is required' }, { status: 400 })
    }

    const admin = await createServiceRoleClient()

    // Load the conversation (service-role — RLS off, so we scope explicitly).
    const { data: conv, error: convErr } = await admin
      .from('conversations')
      .select(CONVERSATION_COLUMNS)
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    const conversation = conv as ConversationRecord

    // Account-scope guard: 403 if the caller can't touch this conversation.
    const allowed = await assertAccountAccess(ctx, conversation.account_id)
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }

    // RBAC: applying a macro mutates the conversation (status/tags/assignee/priority).
    if (!(await userIdCan(ctx.userId, 'action:message.send'))) {
      return NextResponse.json({ error: 'Forbidden: missing permission' }, { status: 403 })
    }

    // Load the macro.
    const { data: macroRow, error: macroErr } = await admin
      .from('macros')
      .select('id, company_id, name, is_active, actions')
      .eq('id', macroId)
      .maybeSingle()
    if (macroErr || !macroRow) {
      return NextResponse.json({ error: 'Macro not found' }, { status: 404 })
    }
    const macro = macroRow as MacroRecord
    if (macro.is_active === false) {
      return NextResponse.json({ error: 'Macro is inactive' }, { status: 422 })
    }

    // The macro must belong to the SAME company as the conversation. Resolve
    // the conversation's company via its account, then compare.
    const convCompanyId = await resolveConversationCompanyId(admin, conversation.account_id)
    if (!convCompanyId) {
      return NextResponse.json(
        { error: 'Cannot apply macro: conversation has no company linkage' },
        { status: 422 },
      )
    }
    // super_admin may cross tenants; everyone else requires an exact match.
    if (!ctx.isSuperAdmin && macro.company_id !== convCompanyId) {
      return NextResponse.json(
        { error: 'Macro belongs to a different company than the conversation' },
        { status: 403 },
      )
    }

    // Apply the actions (validates each; never sends a message).
    let result
    try {
      result = await applyMacro(admin, macro, conversation, convCompanyId)
    } catch (err) {
      if (err instanceof MacroValidationError) {
        return NextResponse.json({ error: err.message }, { status: 422 })
      }
      throw err
    }

    // Audit — surfaces on the conversation activity timeline. Best-effort.
    if (result.applied.length > 0) {
      try {
        await admin.from('audit_log').insert({
          user_id: ctx.userId,
          company_id: convCompanyId,
          action: 'conversation.macro_applied',
          entity_type: 'conversation',
          entity_id: conversationId,
          details: {
            macro_id: macro.id,
            macro_name: macro.name,
            applied: result.applied,
            account_id: conversation.account_id,
            summary: `Applied macro "${macro.name}"`,
          },
        })
      } catch {
        /* non-critical */
      }
    }

    // Re-read the conversation so the client gets the post-update row.
    const { data: updatedConv } = await admin
      .from('conversations')
      .select(CONVERSATION_COLUMNS)
      .eq('id', conversationId)
      .maybeSingle()

    return NextResponse.json({
      applied: result.applied,
      // Composer-only hint: the template text the UI should INSERT (never sent).
      insert_template_id: result.insertTemplateId,
      conversation: updatedConv ?? conversation,
    })
  } catch (err) {
    console.error('Apply-macro POST error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    )
  }
}
