/**
 * POST /api/conversations/[id]/time/manual
 *
 * Body: { duration_seconds: number; notes?: string; started_at?: string }
 *
 * Manual time entry — agent claims they spent N seconds on this
 * conversation. Inserted as a single closed row with `source = 'manual'`.
 *
 * Defends against runaway values with `MAX_MANUAL_DURATION_SECONDS`
 * (24h ceiling). `started_at` defaults to "now - duration" so the entry
 * appears in the right time window in per-day rollups.
 */

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { verifyAccountAccess, checkRateLimit } from '@/lib/api-helpers'
import { MAX_MANUAL_DURATION_SECONDS } from '@/lib/time-tracking'

interface Body {
  duration_seconds?: number
  notes?: string
  started_at?: string
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: conversationId } = await context.params
    if (!conversationId) {
      return NextResponse.json(
        { error: 'Missing conversation id' },
        { status: 400 }
      )
    }

    const supabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!(await checkRateLimit(`time-manual:${user.id}`, 30, 60))) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429 }
      )
    }

    const body = (await request.json().catch(() => ({}))) as Body
    const duration = Number(body.duration_seconds)
    if (!Number.isFinite(duration) || duration <= 0) {
      return NextResponse.json(
        { error: 'duration_seconds must be a positive number' },
        { status: 400 }
      )
    }
    if (duration > MAX_MANUAL_DURATION_SECONDS) {
      return NextResponse.json(
        {
          error: `duration_seconds must be <= ${MAX_MANUAL_DURATION_SECONDS} (24h)`,
        },
        { status: 400 }
      )
    }
    const durationInt = Math.floor(duration)
    const notes =
      typeof body.notes === 'string' ? body.notes.trim().slice(0, 500) : null

    const admin = await createServiceRoleClient()
    const { data: conv, error: convErr } = await admin
      .from('conversations')
      .select('id, account_id')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    const allowed = await verifyAccountAccess(user.id, conv.account_id)
    if (!allowed) {
      return NextResponse.json(
        { error: 'Forbidden: account scope mismatch' },
        { status: 403 }
      )
    }

    // Resolve started_at: explicit ISO if provided + valid + not in the
    // future, else now - duration. ended_at = started_at + duration.
    const nowMs = Date.now()
    let startedMs: number
    if (body.started_at) {
      const parsed = Date.parse(body.started_at)
      if (!Number.isFinite(parsed) || parsed > nowMs) {
        return NextResponse.json(
          { error: 'started_at must be a valid ISO timestamp not in the future' },
          { status: 400 }
        )
      }
      startedMs = parsed
    } else {
      startedMs = nowMs - durationInt * 1000
    }
    const endedMs = startedMs + durationInt * 1000

    const { data, error } = await admin
      .from('conversation_time_entries')
      .insert({
        conversation_id: conversationId,
        user_id: user.id,
        account_id: conv.account_id,
        started_at: new Date(startedMs).toISOString(),
        ended_at: new Date(endedMs).toISOString(),
        duration_seconds: durationInt,
        source: 'manual',
        notes,
      })
      .select('id')
      .single()
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message || 'Failed to insert entry' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      entry_id: (data as { id: string }).id,
      duration_seconds: durationInt,
    })
  } catch (err) {
    console.error('Time manual error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
