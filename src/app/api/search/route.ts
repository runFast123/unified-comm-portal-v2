// GET /api/search?q=...
//
// Global full-text search across the caller's conversations (participant,
// subject, and message bodies), powered by the Postgres `search_conversations`
// SECURITY DEFINER RPC (see migration 20260601120000_fulltext_search.sql).
//
// TENANCY: the RPC is company-scoped *inside* the database, but it derives the
// tenant from auth.uid(). So it MUST be invoked through the user-context client
// (createServerSupabaseClient) — NOT the service-role client, where auth.uid()
// is NULL and the function would fail closed (empty result). Calling it on the
// user client is also what lets RLS-equivalent scoping work for super_admins
// (cross-tenant) vs. company users (their company only).

import { NextResponse } from 'next/server'

import { createServerSupabaseClient } from '@/lib/supabase-server'

export interface SearchResult {
  id: string
  account_id: string
  participant_name: string | null
  participant_email: string | null
  channel: string | null
  status: string | null
  last_message_at: string | null
  /** ts_headline snippet with <mark>…</mark> around matches. */
  headline: string | null
  rank: number
}

// Cap how much we ask the DB for; the function itself also clamps p_limit.
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 50

export async function GET(request: Request) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const rawQuery = (url.searchParams.get('q') ?? '').trim()

  // Empty / whitespace-only query → no work, empty result.
  if (!rawQuery) {
    return NextResponse.json({ results: [] })
  }

  const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), MAX_LIMIT)
    : DEFAULT_LIMIT

  // Optional tenant-switcher scope. The RPC already enforces company scope
  // (the caller's company, or everything for super_admin); this only *narrows*
  // to the company a super_admin has selected in the switcher, keeping search
  // consistent with the rest of the app. We resolve the account set with the
  // SAME user-context client, so RLS guarantees this can never widen the
  // caller's reach — only filter it down (a non-entitled company_id yields an
  // empty allow-set → no results).
  const companyId = (url.searchParams.get('company_id') ?? '').trim() || null

  // IMPORTANT: call through the user-context client so auth.uid() is set inside
  // the SECURITY DEFINER function and company scoping applies.
  const { data, error } = await supabase.rpc('search_conversations', {
    p_query: rawQuery,
    p_limit: limit,
  })

  if (error) {
    console.error('search_conversations RPC error:', error)
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }

  let results = (data ?? []) as SearchResult[]

  if (companyId) {
    const { data: accts } = await supabase
      .from('accounts')
      .select('id')
      .eq('company_id', companyId)
    const allowed = new Set((accts ?? []).map((a: { id: string }) => a.id))
    results = results.filter((r) => allowed.has(r.account_id))
  }

  return NextResponse.json({ results })
}
