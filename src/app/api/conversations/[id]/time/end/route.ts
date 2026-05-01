/**
 * POST /api/conversations/[id]/time/end
 *
 * Body: { session_id: string }
 *
 * Closes the session: sets `ended_at = now()` and computes
 * `duration_seconds`. Idempotent — already-closed sessions are a no-op.
 *
 * Designed to be called via `navigator.sendBeacon` on tab close, which
 * means the response body may not be read on the client. We still return
 * structured JSON so the equivalent fetch() path during graceful unmount
 * gets useful data.
 */

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { checkRateLimit } from '@/lib/api-helpers'
import { closeSession } from '@/lib/time-tracking'

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

    if (!(await checkRateLimit(`time-end:${user.id}`, 120, 60))) {
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
    const { data: row } = await admin
      .from('conversation_time_entries')
      .select('id, user_id, conversation_id')
      .eq('id', sessionId)
      .maybeSingle()
    if (!row) {
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

    const duration = await closeSession(admin, sessionId)
    return NextResponse.json({
      ok: duration !== null,
      duration_seconds: duration,
    })
  } catch (err) {
    console.error('Time end error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
