/**
 * POST /api/conversations/[id]/status
 *
 * Updates a conversation's primary status (the lifecycle ENUM) and/or its
 * company-defined `secondary_status` + color. Writes an audit_log entry so
 * the change shows up on the activity timeline.
 *
 * Body shape:
 *   {
 *     status?: ConversationStatus,
 *     secondary_status?: string | null,
 *     secondary_status_color?: string | null,
 *   }
 *
 * Either field may be set — at least one is required.
 *
 * Auth: must be authenticated and have access to the conversation's account
 * (verifyAccountAccess — same gate /snooze uses).
 */

import { NextResponse, after } from 'next/server'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { verifyAccountAccess } from '@/lib/api-helpers'
import { fireWebhook } from '@/lib/webhook-dispatcher'
import { maybeAutoSendCSAT } from './csat-hook'
import type { ConversationStatus } from '@/types/database'

const VALID_STATUSES: readonly ConversationStatus[] = [
  'active',
  'in_progress',
  'waiting_on_customer',
  'resolved',
  'escalated',
  'archived',
]

interface PostBody {
  status?: ConversationStatus
  secondary_status?: string | null
  secondary_status_color?: string | null
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
    const hasStatus = body.status !== undefined
    const hasSecondary = body.secondary_status !== undefined
    if (!hasStatus && !hasSecondary) {
      return NextResponse.json(
        { error: 'Provide `status` and/or `secondary_status`' },
        { status: 400 }
      )
    }

    if (hasStatus && (typeof body.status !== 'string' || !VALID_STATUSES.includes(body.status))) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` },
        { status: 400 }
      )
    }

    const admin = await createServiceRoleClient()

    const { data: conv, error: convErr } = await admin
      .from('conversations')
      .select('id, account_id, status, secondary_status, secondary_status_color')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const allowed = await verifyAccountAccess(user.id, conv.account_id)
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }

    // M4 fix: validate secondary_status_color shape. Without this anyone
    // with conversation access could stuff a 1MB blob or HTML/JS into the
    // column — UI components that render the color verbatim would break
    // (or worse, render attacker-controlled markup if a future component
    // inlined it as an attribute). Accept `#rgb`, `#rgba`, `#rrggbb`,
    // `#rrggbbaa`. Null/undefined are allowed (clears the color).
    if (
      body.secondary_status_color !== undefined &&
      body.secondary_status_color !== null &&
      !/^#(?:[0-9a-fA-F]{3,8})$/.test(body.secondary_status_color)
    ) {
      return NextResponse.json(
        { error: 'secondary_status_color must be a hex string like #rrggbb' },
        { status: 400 }
      )
    }

    const update: Record<string, unknown> = {}
    if (hasStatus) update.status = body.status
    if (hasSecondary) {
      update.secondary_status = body.secondary_status ?? null
      update.secondary_status_color = body.secondary_status_color ?? null
    }

    const { error: updateErr } = await admin
      .from('conversations')
      .update(update)
      .eq('id', conversationId)
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    // Best-effort audit. Activity timeline reads from audit_log and surfaces
    // these as "Status changed" entries.
    try {
      if (hasStatus && body.status !== conv.status) {
        await admin.from('audit_log').insert({
          user_id: user.id,
          action: 'conversation.status_changed',
          entity_type: 'conversation',
          entity_id: conversationId,
          details: {
            from: conv.status,
            to: body.status,
            account_id: conv.account_id,
            summary: `Status changed from ${conv.status} to ${body.status}`,
          },
        })
      }
      if (hasSecondary && body.secondary_status !== conv.secondary_status) {
        await admin.from('audit_log').insert({
          user_id: user.id,
          action: 'conversation.secondary_status_changed',
          entity_type: 'conversation',
          entity_id: conversationId,
          details: {
            from: conv.secondary_status,
            to: body.secondary_status,
            color: body.secondary_status_color ?? null,
            account_id: conv.account_id,
            summary: body.secondary_status
              ? `Sub-status set to "${body.secondary_status}"`
              : 'Sub-status cleared',
          },
        })
      }
    } catch {
      /* non-critical */
    }

    // ── CSAT auto-send (best-effort) ─────────────────────────────────
    // When the status flips TO `resolved`, optionally email the customer
    // a one-click rating link. Wrapped in try/catch — must NEVER block
    // the status update from succeeding. Skips when the company hasn't
    // opted in, when there's no customer email, or when a CSAT was sent
    // for this conversation in the last 30 days.
    if (hasStatus && body.status === 'resolved' && conv.status !== 'resolved') {
      try {
        await maybeAutoSendCSAT(admin, conversationId, conv.account_id)
      } catch (err) {
        console.error('CSAT auto-send failed (non-blocking):', err)
      }

      // ── Outgoing webhook: conversation.resolved ───────────────────
      // Fan out to any company-scoped subscribers. after() so a slow
      // customer endpoint can't add latency to the click. Wrapped in
      // try/catch — webhook failures must never block the status update.
      try {
        const { data: account } = await admin
          .from('accounts')
          .select('company_id')
          .eq('id', conv.account_id)
          .maybeSingle()
        const companyId = (account as { company_id: string | null } | null)?.company_id
        if (companyId) {
          after(() =>
            fireWebhook(
              'conversation.resolved',
              {
                conversation_id: conversationId,
                account_id: conv.account_id,
                resolved_by: user.id,
                resolved_at: new Date().toISOString(),
              },
              companyId,
            ).catch(() => {/* dispatcher logs internally */}),
          )
        }
      } catch (err) {
        console.error('conversation.resolved webhook fire failed (non-blocking):', err)
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Status POST error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
