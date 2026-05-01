/**
 * GET /api/v1/conversations
 *
 * Public-facing, token-authed listing of the company's conversations.
 *   - Auth: `Authorization: Bearer ucp_...`
 *   - Required scope: `conversations:read`
 *   - Pagination: `?limit=` (default 50, max 100), `?offset=` (default 0)
 *   - Filter: `?status=` (any of the conversation_status enum values)
 *
 * Results are scoped by `tokenInfo.company_id` — every account belonging to
 * the company is included. Order is `last_message_at DESC` so the freshest
 * threads appear first (matches the inbox UI).
 */

import { NextResponse } from 'next/server'

import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireToken } from '@/app/api/v1/_helpers'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

export async function GET(request: Request) {
  const gate = await requireToken(request, 'conversations:read')
  if (!gate.ok) return gate.response

  const url = new URL(request.url)
  const limitRaw = Number(url.searchParams.get('limit'))
  const offsetRaw = Number(url.searchParams.get('offset'))
  const status = url.searchParams.get('status')

  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, Math.floor(limitRaw)) : DEFAULT_LIMIT
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0

  const admin = await createServiceRoleClient()

  // Resolve the set of accounts in this company so we can scope the query.
  const { data: accounts, error: accountsErr } = await admin
    .from('accounts')
    .select('id')
    .eq('company_id', gate.token.company_id)
  if (accountsErr) {
    return NextResponse.json({ error: accountsErr.message }, { status: 500 })
  }
  const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)
  if (accountIds.length === 0) {
    return NextResponse.json({ conversations: [], limit, offset, total: 0 })
  }

  let query = admin
    .from('conversations')
    .select(
      'id, account_id, channel, status, priority, participant_name, participant_email, participant_phone, tags, first_message_at, last_message_at, created_at',
      { count: 'exact' },
    )
    .in('account_id', accountIds)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1)

  if (status) {
    query = query.eq('status', status)
  }

  const { data, error, count } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    conversations: data ?? [],
    limit,
    offset,
    total: count ?? null,
  })
}
