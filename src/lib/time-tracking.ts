// Per-conversation time tracking — pure helpers around the
// `conversation_time_entries` table.
//
// Sessions life-cycle:
//   1. `startSession`   - inserts a row with `started_at = now()`, `ended_at = NULL`.
//                         Auto-closes any prior open session for this user+conv.
//   2. `heartbeat`      - bumps `ended_at = now()` so the GC won't reap the row.
//   3. `closeSession`   - sets `ended_at = now()` + computes `duration_seconds`.
//                         Idempotent: a session that's already closed stays put.
//   4. `garbageCollectStaleSessions` - cron-driven. Closes any session whose
//                         last `ended_at` (or `started_at` if no heartbeat)
//                         is more than STALE_THRESHOLD_SECONDS old, billing
//                         the elapsed time minus the stale tail.
//
// Aggregates:
//   - `aggregateForConversation` - total seconds across all users for one conv.
//   - `aggregateForUser` - per-day + per-conversation breakdown for one user.
//   - `aggregateForCompany` - per-agent ranking across a company.
//
// All functions accept a Supabase client so callers control the auth context
// (RLS-bound user client for self-scoped reads, service-role for admin
// reports + the GC cron).

import type { SupabaseClient } from '@supabase/supabase-js'

// ── Constants ───────────────────────────────────────────────────────

/** Sessions that haven't been heartbeated in this many seconds are
 *  considered abandoned (tab closed without graceful end). */
export const STALE_THRESHOLD_SECONDS = 5 * 60

/** Per-run cap so the GC cron can't monopolise an invocation. */
export const GC_BATCH_LIMIT = 500

/** Maximum manual entry duration: 24h. Defends against bad input / typos. */
export const MAX_MANUAL_DURATION_SECONDS = 24 * 60 * 60

// ── Types ───────────────────────────────────────────────────────────

export interface TimeEntryRow {
  id: string
  conversation_id: string
  user_id: string
  account_id: string
  started_at: string
  ended_at: string | null
  duration_seconds: number | null
  source: 'auto' | 'manual'
  notes: string | null
  created_at: string
}

export interface PerUserBreakdown {
  user_id: string
  total_seconds: number
  entry_count: number
}

export interface ConversationAggregate {
  conversation_id: string
  total_seconds: number
  entry_count: number
  per_user: PerUserBreakdown[]
}

export interface PerDayBreakdown {
  /** ISO yyyy-mm-dd in UTC. */
  date: string
  total_seconds: number
}

export interface PerConversationBreakdown {
  conversation_id: string
  total_seconds: number
  entry_count: number
}

export interface UserAggregate {
  user_id: string
  total_seconds: number
  per_day: PerDayBreakdown[]
  per_conversation: PerConversationBreakdown[]
}

export interface AgentRankingRow {
  user_id: string
  total_seconds: number
  entry_count: number
  conversation_count: number
}

// ── Internal utilities ──────────────────────────────────────────────

/** Compute duration in whole seconds between two ISO timestamps. Floors to
 *  zero on negative spans (clock skew). */
function diffSeconds(startedAtIso: string, endedAtIso: string): number {
  const startMs = Date.parse(startedAtIso)
  const endMs = Date.parse(endedAtIso)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0
  const delta = Math.floor((endMs - startMs) / 1000)
  return delta > 0 ? delta : 0
}

/** Returns yyyy-mm-dd (UTC) for an ISO timestamp. */
function utcDateKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

// ── Session management ─────────────────────────────────────────────

/**
 * Start a new auto-tracked session for (user, conversation, account).
 *
 * Closes any open session this user already has for this conversation
 * before creating the new one — defends against the user opening the same
 * conversation in two tabs (the second tab wins).
 *
 * Returns the new session id, or `null` on failure.
 */
export async function startSession(
  client: SupabaseClient,
  conversationId: string,
  accountId: string,
  userId: string
): Promise<string | null> {
  if (!conversationId || !accountId || !userId) return null
  const nowIso = new Date().toISOString()

  // 1. Close any prior open session for this user+conv. Best-effort —
  //    an error here shouldn't block the new session from starting.
  const { data: opens } = await client
    .from('conversation_time_entries')
    .select('id, started_at')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .is('ended_at', null)

  if (opens && opens.length > 0) {
    for (const row of opens as Array<{ id: string; started_at: string }>) {
      const duration = diffSeconds(row.started_at, nowIso)
      await client
        .from('conversation_time_entries')
        .update({ ended_at: nowIso, duration_seconds: duration })
        .eq('id', row.id)
        .is('ended_at', null) // CAS — don't clobber if cron beat us
    }
  }

  // 2. Insert the new session.
  const { data, error } = await client
    .from('conversation_time_entries')
    .insert({
      conversation_id: conversationId,
      user_id: userId,
      account_id: accountId,
      started_at: nowIso,
      ended_at: null,
      duration_seconds: null,
      source: 'auto',
    })
    .select('id')
    .single()

  if (error || !data) return null
  return (data as { id: string }).id
}

/**
 * Bump `ended_at = now()` on an active session. Idempotent — if the session
 * is already closed (cron beat us / user clicked end), we don't touch it.
 */
export async function heartbeat(
  client: SupabaseClient,
  sessionId: string
): Promise<boolean> {
  if (!sessionId) return false
  const nowIso = new Date().toISOString()
  const { data, error } = await client
    .from('conversation_time_entries')
    .update({ ended_at: nowIso })
    .eq('id', sessionId)
    .is('ended_at', null) // only extend OPEN sessions
    .select('id')
    .maybeSingle()
  if (error) return false
  return Boolean(data)
}

/**
 * Close an active session. Sets `ended_at = now()` and computes
 * `duration_seconds` from `started_at`.
 *
 * Idempotent — a session that's already closed is left alone (returns `null`).
 * Returns the final duration in seconds when this call closed the session.
 */
export async function closeSession(
  client: SupabaseClient,
  sessionId: string
): Promise<number | null> {
  if (!sessionId) return null

  // Read first so we know started_at.
  const { data: row } = await client
    .from('conversation_time_entries')
    .select('id, started_at, ended_at')
    .eq('id', sessionId)
    .maybeSingle()
  if (!row) return null
  const r = row as { id: string; started_at: string; ended_at: string | null }
  if (r.ended_at) return null // already closed — idempotent

  const nowIso = new Date().toISOString()
  const duration = diffSeconds(r.started_at, nowIso)
  const { data: updated, error } = await client
    .from('conversation_time_entries')
    .update({ ended_at: nowIso, duration_seconds: duration })
    .eq('id', sessionId)
    .is('ended_at', null) // CAS
    .select('id')
    .maybeSingle()
  if (error || !updated) return null
  return duration
}

/**
 * Cron-driven cleanup: close any session whose last heartbeat (`ended_at`,
 * or `started_at` if never heartbeated) is older than STALE_THRESHOLD_SECONDS.
 *
 * For stale sessions we bill the duration through the LAST KNOWN ALIVE moment
 * (the existing `ended_at`, or `started_at` if no heartbeat) — that way we
 * don't credit users for the 5-minute grace window after their tab actually
 * went away.
 */
export async function garbageCollectStaleSessions(
  client: SupabaseClient
): Promise<{ closed: number; failed: number }> {
  const now = new Date()
  const staleCutoffIso = new Date(
    now.getTime() - STALE_THRESHOLD_SECONDS * 1000
  ).toISOString()

  // Only need rows that are still open AND haven't been touched recently.
  // We compare on `started_at` because that's always set; we could compare
  // on COALESCE(ended_at, started_at) via .or() but the simpler strategy
  // is "fetch open rows older than cutoff and decide per-row" since the
  // expected backlog at any moment is tiny.
  const { data, error } = await client
    .from('conversation_time_entries')
    .select('id, started_at, ended_at')
    .is('ended_at', null)
    .lte('started_at', staleCutoffIso)
    .limit(GC_BATCH_LIMIT)
  if (error) return { closed: 0, failed: 1 }

  const candidates = (data ?? []) as Array<{
    id: string
    started_at: string
    ended_at: string | null
  }>

  // We need to ALSO consider rows that were heartbeated but stopped recently.
  // Above query missed those if started_at > staleCutoff but heartbeats stopped
  // before. Pull a second pass for OPEN rows whose started_at is more recent
  // but might still be stale via ended_at. We piggyback by selecting all
  // open rows with at least one heartbeat (ended_at IS NOT NULL is impossible
  // since we filter by that) — so we compare by selecting where started_at
  // OR ended_at is stale. Postgres .or() filter handles this:
  const { data: data2 } = await client
    .from('conversation_time_entries')
    .select('id, started_at, ended_at')
    .is('ended_at', null)
    .gt('started_at', staleCutoffIso)
    .limit(GC_BATCH_LIMIT)
  // The above pulls fresh open rows; we just need to compare each one's
  // implicit "last alive" (started_at, since ended_at is NULL while open).
  // If ended_at is NULL, last alive == started_at, which we already know
  // is > cutoff -> NOT stale. Skip.
  // (No-op block kept for documentation; nothing to add.)
  void data2

  let closed = 0
  let failed = 0
  for (const row of candidates) {
    // Last known alive moment: use ended_at (last heartbeat) if present,
    // else started_at. While the row is open ended_at IS NULL, so this
    // reduces to started_at for un-heartbeated sessions.
    const lastAliveIso = row.ended_at ?? row.started_at
    const duration = diffSeconds(row.started_at, lastAliveIso)
    const { data: updated, error: updErr } = await client
      .from('conversation_time_entries')
      .update({ ended_at: lastAliveIso, duration_seconds: duration })
      .eq('id', row.id)
      .is('ended_at', null) // CAS
      .select('id')
      .maybeSingle()
    if (updErr) {
      failed++
    } else if (updated) {
      closed++
    }
  }
  return { closed, failed }
}

// ── Aggregates ─────────────────────────────────────────────────────

/**
 * Total seconds + per-user breakdown for one conversation.
 * Includes both 'auto' and 'manual' entries.
 */
export async function aggregateForConversation(
  client: SupabaseClient,
  conversationId: string
): Promise<ConversationAggregate> {
  const empty: ConversationAggregate = {
    conversation_id: conversationId,
    total_seconds: 0,
    entry_count: 0,
    per_user: [],
  }
  if (!conversationId) return empty

  const { data, error } = await client
    .from('conversation_time_entries')
    .select('user_id, duration_seconds, started_at, ended_at')
    .eq('conversation_id', conversationId)
  if (error || !data) return empty

  const rows = data as Array<{
    user_id: string
    duration_seconds: number | null
    started_at: string
    ended_at: string | null
  }>

  const byUser = new Map<string, { total: number; count: number }>()
  let total = 0
  let entryCount = 0
  for (const r of rows) {
    // Prefer the denormalized duration; fall back to live calculation
    // for sessions still open so the running total includes "right now".
    let secs = r.duration_seconds ?? 0
    if (r.duration_seconds == null && r.ended_at == null) {
      // open session — count time elapsed so far
      secs = diffSeconds(r.started_at, new Date().toISOString())
    } else if (r.duration_seconds == null && r.ended_at) {
      secs = diffSeconds(r.started_at, r.ended_at)
    }
    total += secs
    entryCount++
    const cur = byUser.get(r.user_id) ?? { total: 0, count: 0 }
    cur.total += secs
    cur.count += 1
    byUser.set(r.user_id, cur)
  }

  const per_user: PerUserBreakdown[] = Array.from(byUser.entries())
    .map(([user_id, v]) => ({
      user_id,
      total_seconds: v.total,
      entry_count: v.count,
    }))
    .sort((a, b) => b.total_seconds - a.total_seconds)

  return {
    conversation_id: conversationId,
    total_seconds: total,
    entry_count: entryCount,
    per_user,
  }
}

/**
 * Per-day + per-conversation breakdown for one user since `dateFrom`.
 * `dateFrom` is an ISO timestamp; pass an empty string to fetch all-time
 * (capped to the natural row count — there's no LIMIT here, callers should
 * narrow the range).
 */
export async function aggregateForUser(
  client: SupabaseClient,
  userId: string,
  dateFrom: string
): Promise<UserAggregate> {
  const empty: UserAggregate = {
    user_id: userId,
    total_seconds: 0,
    per_day: [],
    per_conversation: [],
  }
  if (!userId) return empty

  let query = client
    .from('conversation_time_entries')
    .select('conversation_id, duration_seconds, started_at, ended_at')
    .eq('user_id', userId)

  if (dateFrom) {
    query = query.gte('started_at', dateFrom)
  }

  const { data, error } = await query
  if (error || !data) return empty

  const rows = data as Array<{
    conversation_id: string
    duration_seconds: number | null
    started_at: string
    ended_at: string | null
  }>

  const byDay = new Map<string, number>()
  const byConv = new Map<string, { total: number; count: number }>()
  let total = 0
  for (const r of rows) {
    let secs = r.duration_seconds ?? 0
    if (r.duration_seconds == null && r.ended_at == null) {
      secs = diffSeconds(r.started_at, new Date().toISOString())
    } else if (r.duration_seconds == null && r.ended_at) {
      secs = diffSeconds(r.started_at, r.ended_at)
    }
    total += secs

    const day = utcDateKey(r.started_at)
    if (day) byDay.set(day, (byDay.get(day) ?? 0) + secs)

    const cur = byConv.get(r.conversation_id) ?? { total: 0, count: 0 }
    cur.total += secs
    cur.count += 1
    byConv.set(r.conversation_id, cur)
  }

  const per_day = Array.from(byDay.entries())
    .map(([date, total_seconds]) => ({ date, total_seconds }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  const per_conversation = Array.from(byConv.entries())
    .map(([conversation_id, v]) => ({
      conversation_id,
      total_seconds: v.total,
      entry_count: v.count,
    }))
    .sort((a, b) => b.total_seconds - a.total_seconds)

  return {
    user_id: userId,
    total_seconds: total,
    per_day,
    per_conversation,
  }
}

/**
 * Per-agent ranking across all accounts in the given company since `dateFrom`.
 *
 * Implementation: fetch the company's account ids, then aggregate entries
 * scoped to those accounts. The caller must supply a service-role client
 * because the scope spans multiple users' rows.
 */
export async function aggregateForCompany(
  client: SupabaseClient,
  companyId: string,
  dateFrom: string
): Promise<AgentRankingRow[]> {
  if (!companyId) return []

  // Resolve the company's account ids.
  const { data: accounts, error: accErr } = await client
    .from('accounts')
    .select('id')
    .eq('company_id', companyId)
  if (accErr || !accounts) return []
  const accountIds = (accounts as Array<{ id: string }>).map((a) => a.id)
  if (accountIds.length === 0) return []

  let query = client
    .from('conversation_time_entries')
    .select('user_id, conversation_id, duration_seconds, started_at, ended_at')
    .in('account_id', accountIds)
  if (dateFrom) query = query.gte('started_at', dateFrom)

  const { data, error } = await query
  if (error || !data) return []

  const rows = data as Array<{
    user_id: string
    conversation_id: string
    duration_seconds: number | null
    started_at: string
    ended_at: string | null
  }>

  const byUser = new Map<
    string,
    { total: number; count: number; convs: Set<string> }
  >()
  for (const r of rows) {
    let secs = r.duration_seconds ?? 0
    if (r.duration_seconds == null && r.ended_at == null) {
      secs = diffSeconds(r.started_at, new Date().toISOString())
    } else if (r.duration_seconds == null && r.ended_at) {
      secs = diffSeconds(r.started_at, r.ended_at)
    }
    const cur =
      byUser.get(r.user_id) ?? { total: 0, count: 0, convs: new Set<string>() }
    cur.total += secs
    cur.count += 1
    cur.convs.add(r.conversation_id)
    byUser.set(r.user_id, cur)
  }

  return Array.from(byUser.entries())
    .map(([user_id, v]) => ({
      user_id,
      total_seconds: v.total,
      entry_count: v.count,
      conversation_count: v.convs.size,
    }))
    .sort((a, b) => b.total_seconds - a.total_seconds)
}

// ── Test-friendly exports ──────────────────────────────────────────

/** Exposed for unit tests. Compute duration in whole seconds between two
 *  ISO timestamps; floors to zero on negative spans. */
export const _internals = { diffSeconds, utcDateKey }
