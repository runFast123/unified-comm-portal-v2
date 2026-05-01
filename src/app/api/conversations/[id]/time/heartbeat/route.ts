/**
 * POST /api/conversations/[id]/time/heartbeat
 *
 * Body: { session_id: string }
 *
 * Idempotent — bumps `ended_at = now()` on an OPEN session so the GC cron
 * doesn't reap it. Closed sessions are silently ignored (returns ok=false).
 *
 * The session_id must belong to the calling user; the underlying RLS
 * UPDATE policy enforces that. We additionally verify the path conversation
 * matches the session's conversation so a malicious client can't tunnel
 * a heartbeat for an unrelated session through this endpoint.
 */

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { checkRateLimit } from '@/lib/api-helpers'
import { heartbeat } from '@/lib/time-tracking'

interface Body {
  session_id?: string
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

    // Heartbeats fire every ~60s — be generous.
    if (!(await checkRateLimit(`time-hb:${user.id}`, 240, 60))) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429 }
      )
    }

    const body = (await request.json().catch(() => ({}))) as Body
    const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
    if (!sessionId) {
      return NextResponse.json(
        { error: 'session_id is required' },
        { status: 400 }
      )
    }

    const admin = await createServiceRoleClient()

    // Validate ownership + matching conversation.
    const { data: row, error } = await admin
      .from('conversation_time_entries')
      .select('id, user_id, conversation_id')
      .eq('id', sessionId)
      .maybeSingle()
    if (error || !row) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    const r = row as {
      id: string
      user_id: string
      conversation_id: string
    }
    if (r.user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (r.conversation_id !== conversationId) {
      return NextResponse.json(
        { error: 'Session does not belong to this conversation' },
        { status: 400 }
      )
    }

    const ok = await heartbeat(admin, sessionId)
    return NextResponse.json({ ok })
  } catch (err) {
    console.error('Time heartbeat error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
