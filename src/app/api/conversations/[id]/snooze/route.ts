import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { verifyAccountAccess, checkRateLimit } from '@/lib/api-helpers'
import { userIdCan } from '@/lib/permissions/server'
import { userCanAccessConversationChannel } from '@/lib/permissions/channel-access'

// Hard cap: don't accept anything more than 1 year out. Same horizon used by
// scheduled-messages for parity.
const MAX_SNOOZE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000
// Floor: must be at least 1 minute in the future. Guards clock skew + misclicks.
const MIN_SNOOZE_FUTURE_MS = 60 * 1000

type SnoozePreset =
  | 'in_1h'
  | 'in_3h'
  | 'tomorrow_9am'
  | 'next_monday_9am'
  | 'in_3_days'
  | 'in_1_week'

interface SnoozeBody {
  until?: string
  preset?: SnoozePreset
}

/**
 * Resolve a preset name to an absolute Date.
 *
 * Timezone policy: presets that target a wall-clock hour ("Tomorrow 9am",
 * "Next Monday 9am") are resolved against the SERVER's local timezone (which
 * on Vercel is UTC). The conversation-actions component sends only `preset`
 * names, so the user's expectation is "9am UTC" wherever the cron runs.
 *
 * Future improvement: accept an IANA tz name from the client and offset
 * accordingly. For now, the relative presets ("in 1 hour", "in 3 days") are
 * timezone-agnostic and work everywhere; the wall-clock presets are
 * documented as UTC.
 */
function resolvePreset(preset: SnoozePreset, now = new Date()): Date {
  const d = new Date(now.getTime())
  switch (preset) {
    case 'in_1h':
      d.setTime(d.getTime() + 60 * 60 * 1000)
      d.setSeconds(0, 0)
      return d
    case 'in_3h':
      d.setTime(d.getTime() + 3 * 60 * 60 * 1000)
      d.setSeconds(0, 0)
      return d
    case 'tomorrow_9am': {
      // 9am UTC the day after `now`.
      d.setUTCDate(d.getUTCDate() + 1)
      d.setUTCHours(9, 0, 0, 0)
      return d
    }
    case 'next_monday_9am': {
      // 0=Sun ... 6=Sat. If today is Monday, jump to next Monday (7 days).
      const dow = d.getUTCDay()
      const daysUntilMonday = dow === 1 ? 7 : (8 - dow) % 7 || 7
      d.setUTCDate(d.getUTCDate() + daysUntilMonday)
      d.setUTCHours(9, 0, 0, 0)
      return d
    }
    case 'in_3_days':
      d.setUTCDate(d.getUTCDate() + 3)
      d.setSeconds(0, 0)
      return d
    case 'in_1_week':
      d.setUTCDate(d.getUTCDate() + 7)
      d.setSeconds(0, 0)
      return d
    default: {
      // exhaustive check
      const _exhaustive: never = preset
      throw new Error(`Unknown preset: ${_exhaustive}`)
    }
  }
}

/**
 * POST /api/conversations/[id]/snooze
 *
 * Body: { until: ISO string } OR { preset: SnoozePreset }
 *
 * Sets `conversations.snoozed_until` to the resolved time and stamps
 * `snoozed_by = user.id`. The wake-snoozed cron clears these when due.
 */
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

    // Cheap rate limit — keeps a runaway client from hammering this endpoint.
    if (!(await checkRateLimit(`snooze:${user.id}`, 60, 60))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    const body = (await request.json().catch(() => ({}))) as SnoozeBody
    if (!body.until && !body.preset) {
      return NextResponse.json(
        { error: 'Provide either `until` (ISO string) or `preset`' },
        { status: 400 }
      )
    }

    let snoozeUntil: Date
    if (body.preset) {
      try {
        snoozeUntil = resolvePreset(body.preset)
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'Invalid preset' },
          { status: 400 }
        )
      }
    } else {
      snoozeUntil = new Date(body.until!)
      if (Number.isNaN(snoozeUntil.getTime())) {
        return NextResponse.json(
          { error: 'Invalid `until` (must be ISO datetime)' },
          { status: 400 }
        )
      }
    }

    const nowMs = Date.now()
    if (snoozeUntil.getTime() <= nowMs + MIN_SNOOZE_FUTURE_MS) {
      return NextResponse.json(
        { error: 'Snooze time must be at least 1 minute from now' },
        { status: 400 }
      )
    }
    if (snoozeUntil.getTime() > nowMs + MAX_SNOOZE_HORIZON_MS) {
      return NextResponse.json(
        { error: 'Snooze time must be within 365 days' },
        { status: 400 }
      )
    }

    const admin = await createServiceRoleClient()

    // Look up the conversation's account so we can scope-check.
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

    // RBAC: snoozing is an agent write action.
    if (!(await userIdCan(user.id, 'action:message.send'))) {
      return NextResponse.json({ error: 'Forbidden: missing permission' }, { status: 403 })
    }
    // Channel segmentation: respect the caller's channel grants (service-role bypasses RLS).
    if (!(await userCanAccessConversationChannel(user.id, conv.channel))) {
      return NextResponse.json({ error: 'Forbidden: missing channel permission' }, { status: 403 })
    }

    const { error: updateErr } = await admin
      .from('conversations')
      .update({
        snoozed_until: snoozeUntil.toISOString(),
        snoozed_by: user.id,
      })
      .eq('id', conversationId)

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    // Audit (best-effort).
    try {
      await admin.from('audit_log').insert({
        user_id: user.id,
        action: 'conversation.snoozed',
        entity_type: 'conversation',
        entity_id: conversationId,
        details: {
          snoozed_until: snoozeUntil.toISOString(),
          preset: body.preset ?? null,
          account_id: conv.account_id,
        },
      })
    } catch {
      /* non-critical */
    }

    return NextResponse.json({
      success: true,
      snoozed_until: snoozeUntil.toISOString(),
    })
  } catch (err) {
    console.error('Snooze POST error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/conversations/[id]/snooze
 *
 * Clears the snooze. Idempotent — calling on a non-snoozed conversation
 * returns success without doing anything destructive.
 */
export async function DELETE(
  _request: Request,
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

    const admin = await createServiceRoleClient()

    const { data: conv, error: convErr } = await admin
      .from('conversations')
      .select('id, account_id, snoozed_until, channel')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const allowed = await verifyAccountAccess(user.id, conv.account_id)
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }

    // RBAC: clearing a snooze is an agent write action.
    if (!(await userIdCan(user.id, 'action:message.send'))) {
      return NextResponse.json({ error: 'Forbidden: missing permission' }, { status: 403 })
    }
    // Channel segmentation: respect the caller's channel grants (service-role bypasses RLS).
    if (!(await userCanAccessConversationChannel(user.id, conv.channel))) {
      return NextResponse.json({ error: 'Forbidden: missing channel permission' }, { status: 403 })
    }

    // No-op when already not snoozed — but still return success so the client
    // doesn't have to special-case it.
    if (conv.snoozed_until == null) {
      return NextResponse.json({ success: true, snoozed_until: null, noop: true })
    }

    const { error: updateErr } = await admin
      .from('conversations')
      .update({ snoozed_until: null, snoozed_by: null })
      .eq('id', conversationId)
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    try {
      await admin.from('audit_log').insert({
        user_id: user.id,
        action: 'conversation.unsnoozed',
        entity_type: 'conversation',
        entity_id: conversationId,
        details: {
          previous_snoozed_until: conv.snoozed_until,
          account_id: conv.account_id,
        },
      })
    } catch {
      /* non-critical */
    }

    return NextResponse.json({ success: true, snoozed_until: null })
  } catch (err) {
    console.error('Snooze DELETE error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
