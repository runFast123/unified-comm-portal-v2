/**
 * GET /api/conversations/[id]/time
 *
 * Returns:
 *   {
 *     conversation_id,
 *     total_seconds,
 *     entry_count,
 *     per_user: [{ user_id, user_name, total_seconds, entry_count }, ...],
 *     your_seconds,
 *     recent_entries: [{ id, user_id, user_name, source, started_at, ended_at,
 *                         duration_seconds, notes }, ...]  // up to 20
 *   }
 *
 * Auth: must have access to the conversation's account. We use the
 * service-role client to read; RLS on the entries table would enforce
 * the same logic for end-user clients but the explicit verifyAccountAccess
 * here keeps the contract symmetrical with the rest of the conversation
 * API surface (404 vs 403 vs row-by-row hidden).
 */

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { verifyAccountAccess } from '@/lib/api-helpers'
import { aggregateForConversation } from '@/lib/time-tracking'

const RECENT_LIMIT = 20

export async function GET(
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

    const agg = await aggregateForConversation(admin, conversationId)

    // Recent entries — bounded list for the sidebar.
    const { data: recent } = await admin
      .from('conversation_time_entries')
      .select(
        'id, user_id, source, started_at, ended_at, duration_seconds, notes'
      )
      .eq('conversation_id', conversationId)
      .order('started_at', { ascending: false })
      .limit(RECENT_LIMIT)

    // Resolve names for users in the aggregate + recent list (single round-trip).
    const userIds = Array.from(
      new Set([
        ...agg.per_user.map((u) => u.user_id),
        ...((recent ?? []) as Array<{ user_id: string }>).map((r) => r.user_id),
      ])
    )
    const nameById = new Map<string, string>()
    if (userIds.length > 0) {
      const { data: users } = await admin
        .from('users')
        .select('id, full_name, email')
        .in('id', userIds)
      for (const u of (users ?? []) as Array<{
        id: string
        full_name: string | null
        email: string | null
      }>) {
        nameById.set(u.id, u.full_name || u.email || 'Unknown')
      }
    }

    const yourEntry = agg.per_user.find((u) => u.user_id === user.id)
    const your_seconds = yourEntry?.total_seconds ?? 0

    const per_user = agg.per_user.map((u) => ({
      user_id: u.user_id,
      user_name: nameById.get(u.user_id) ?? 'Unknown',
      total_seconds: u.total_seconds,
      entry_count: u.entry_count,
    }))

    const recent_entries = ((recent ?? []) as Array<{
      id: string
      user_id: string
      source: 'auto' | 'manual'
      started_at: string
      ended_at: string | null
      duration_seconds: number | null
      notes: string | null
    }>).map((r) => ({
      id: r.id,
      user_id: r.user_id,
      user_name: nameById.get(r.user_id) ?? 'Unknown',
      source: r.source,
      started_at: r.started_at,
      ended_at: r.ended_at,
      duration_seconds: r.duration_seconds,
      notes: r.notes,
    }))

    return NextResponse.json({
      conversation_id: conversationId,
      total_seconds: agg.total_seconds,
      entry_count: agg.entry_count,
      per_user,
      your_seconds,
      recent_entries,
    })
  } catch (err) {
    console.error('Time GET error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
