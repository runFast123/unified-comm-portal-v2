/**
 * POST /api/conversations/[id]/time/start
 *
 * Open a new auto-tracked time session for the current user. Returns
 * `{ session_id }`. Auto-closes any prior open session for this
 * (user, conversation) pair so opening the same convo in two tabs
 * doesn't double-count.
 *
 * Body: none. The conversation id comes from the path; the user id
 * comes from the auth session; the account id is looked up from the
 * conversation server-side (not trusted from the client).
 */

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { verifyAccountAccess, checkRateLimit } from '@/lib/api-helpers'
import { startSession } from '@/lib/time-tracking'

export async function POST(
  _request: Request,
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

    // Generous limit — UI may legitimately remount during navigation.
    if (!(await checkRateLimit(`time-start:${user.id}`, 120, 60))) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429 }
      )
    }

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

    const sessionId = await startSession(
      admin,
      conversationId,
      conv.account_id,
      user.id
    )
    if (!sessionId) {
      return NextResponse.json(
        { error: 'Failed to start session' },
        { status: 500 }
      )
    }

    return NextResponse.json({ session_id: sessionId })
  } catch (err) {
    console.error('Time start error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
