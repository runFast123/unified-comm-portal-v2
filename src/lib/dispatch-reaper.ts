/**
 * Reaper for stranded dispatch claims, plus the queue-depth probe the admin
 * health page reads.
 *
 * THE BUG THIS EXISTS FOR
 *   dispatch-scheduled claims a queued reply with a compare-and-set:
 *     scheduled_messages: pending -> dispatching
 *     pending_sends:      pending -> sending
 *   and only writes a terminal status (sent/failed) once the send resolves. If
 *   the function dies in between — timeout, OOM, deploy mid-flight, crash — the
 *   row keeps the claim status forever:
 *     * the dispatcher never re-picks it (it selects status='pending')
 *     * the retry endpoint refuses it  (it requires status='failed')
 *   so the reply is silently never sent and only a manual DB write recovers it.
 *
 *   `reapStaleClaims` is the missing recovery path. It runs from the
 *   garbage-collect cron (every 5 minutes) and returns a stale claim to
 *   'pending' so the dispatcher picks it up on its next pass — or, once the row
 *   has burned MAX_DISPATCH_ATTEMPTS, retires it to 'failed', which lights up
 *   the existing failure banner + agent alerting instead of failing silently.
 *
 * SAFETY: claim age is measured from `claimed_at`, never from the due time
 *   scheduled_for/send_at say when a row became DUE, not when it was CLAIMED.
 *   Those coincide only while the queue keeps up. Drain a backlog (cron outage,
 *   big burst) and rows due hours ago get claimed right now — under a due-time
 *   proxy every one looks stale the instant it is claimed, so the reaper would
 *   yank live in-flight sends back to 'pending' and the next run would send them
 *   AGAIN. A double-send to a customer is worse than the stranding this fixes.
 *
 *   So: no claimed_at, no reaping. If the migration
 *   (20260715120000_dispatch_claim_reaper.sql) hasn't been applied,
 *   `reapStaleClaims` reports `degraded` and touches nothing rather than guess.
 *   That also keeps this safe to deploy ahead of the migration — the pre-
 *   migration behaviour is exactly today's behaviour.
 *
 * All functions take a Supabase client so the caller controls auth context.
 * Both entry points need service-role (they span tenants).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logError, logInfo } from './logger'
import { notifyDispatchFailure } from './dispatch-notify'

// ── Constants ───────────────────────────────────────────────────────

/**
 * A claim held longer than this is treated as stranded.
 *
 * Sized to be unambiguous rather than fast: the dispatch cron runs every
 * minute and a real send resolves in seconds, so anything still claimed after
 * 10 minutes cannot be in flight under any function timeout this app can be
 * configured with. Erring high costs a stranded row a few extra minutes of
 * delay; erring low risks reaping a live send and double-sending it.
 */
export const STALE_CLAIM_THRESHOLD_MS = 10 * 60 * 1000

/**
 * Dispatch attempts a row gets before the reaper retires it to 'failed'.
 *
 * Guards against a poison row — one whose payload reliably kills the function
 * (huge attachment, OOM) — being reclaimed and re-killing the function every
 * five minutes forever. Three strands (~30 min) is enough to ride out a
 * transient platform problem while still converging.
 */
export const MAX_DISPATCH_ATTEMPTS = 3

/** Per-run cap so a mass-stranding event can't monopolise one invocation. */
export const REAP_BATCH_LIMIT = 200

// ── Queue descriptors ───────────────────────────────────────────────

export interface QueueSpec {
  table: 'scheduled_messages' | 'pending_sends'
  /** Status the dispatcher CASes 'pending' into while a send is in flight. */
  claimStatus: 'dispatching' | 'sending'
  /** Column the dispatcher's due-window query keys on. */
  timeField: 'scheduled_for' | 'send_at'
  /** Discriminator used by the retry endpoint + failure banner. */
  kind: 'scheduled' | 'pending_send'
  /** Human label for the health UI. */
  label: string
}

export const QUEUES: readonly QueueSpec[] = [
  {
    table: 'scheduled_messages',
    claimStatus: 'dispatching',
    timeField: 'scheduled_for',
    kind: 'scheduled',
    label: 'Scheduled messages',
  },
  {
    table: 'pending_sends',
    claimStatus: 'sending',
    timeField: 'send_at',
    kind: 'pending_send',
    label: 'Undo-window sends',
  },
] as const

// ── Types ───────────────────────────────────────────────────────────

interface ClaimedRow {
  id: string
  conversation_id: string
  channel: string
  to_address: string | null
  created_by: string | null
  attempt_count: number | null
  claimed_at: string | null
}

export interface QueueReapResult {
  table: QueueSpec['table']
  /** Stale claims returned to 'pending' for another go. */
  requeued: number
  /** Stale claims retired to 'failed' — attempt budget spent. */
  retired: number
  /** Rows the dispatcher finished between our SELECT and our CAS. */
  raced: number
  /** Per-row write errors. */
  errors: number
  /** True when this queue was skipped: claim tracking isn't available yet. */
  degraded: boolean
}

export interface ReapReport {
  requeued: number
  retired: number
  raced: number
  errors: number
  /** True if ANY queue was skipped for missing claim tracking. */
  degraded: boolean
  per_queue: QueueReapResult[]
}

export interface QueueHealth {
  table: QueueSpec['table']
  label: string
  /** Queued and waiting, including rows not due yet. */
  pending: number
  /** Queued, due, and still not sent — the real backlog. */
  due_now: number
  /** Claim currently held (normal in flight, or stranded). */
  claimed: number
  /**
   * Claims held past the stale threshold — the stranded-row count.
   * `null` when claim tracking isn't available: we cannot tell, and reporting
   * 0 would read as "all clear".
   */
  stranded: number | null
  /** Awaiting a human on the failure banner. */
  failed: number
  /** Due time of the oldest un-sent due row — how far behind the queue is. */
  oldest_due_at: string | null
  /** False until the claim-tracking migration is applied. */
  claim_tracking: boolean
}

export interface QueueHealthReport {
  queues: QueueHealth[]
  stale_threshold_minutes: number
  max_dispatch_attempts: number
  checked_at: string
}

// ── Capability probe ────────────────────────────────────────────────

/**
 * Whether `claimed_at` / `attempt_count` exist on `table` yet.
 *
 * Cheap (`limit(1)`, one round trip) and called once per queue per run rather
 * than per row. Lets the dispatcher and the reaper both ship before the
 * migration lands: without these columns the dispatcher claims exactly as it
 * does today and the reaper stands down.
 *
 * Any error — missing column (42703), PostgREST schema cache miss (PGRST204),
 * or a transient blip — reads as "no". A false negative just means one run's
 * worth of reaping is skipped, which is the safe direction.
 */
export async function supportsClaimTracking(
  client: SupabaseClient,
  table: QueueSpec['table']
): Promise<boolean> {
  const { error } = await client.from(table).select('claimed_at, attempt_count').limit(1)
  return !error
}

// ── Reaper ──────────────────────────────────────────────────────────

/** The dispatcher's terminal-write shape, so both live in one place. */
export function claimResetPatch(): { claimed_at: null; attempt_count: 0 } {
  return { claimed_at: null, attempt_count: 0 }
}

async function reapQueue(
  client: SupabaseClient,
  queue: QueueSpec,
  staleCutoffIso: string,
  requestId: string
): Promise<QueueReapResult> {
  const result: QueueReapResult = {
    table: queue.table,
    requeued: 0,
    retired: 0,
    raced: 0,
    errors: 0,
    degraded: false,
  }

  if (!(await supportsClaimTracking(client, queue.table))) {
    // Migration not applied. Stand down — see the SAFETY note up top.
    result.degraded = true
    return result
  }

  const { data, error } = await client
    .from(queue.table)
    .select('id, conversation_id, channel, to_address, created_by, attempt_count, claimed_at')
    .eq('status', queue.claimStatus)
    .lte('claimed_at', staleCutoffIso)
    .order('claimed_at', { ascending: true })
    .limit(REAP_BATCH_LIMIT)

  if (error) {
    await logError('system', 'reap_stale_claims_query_error', error.message, {
      request_id: requestId,
      table: queue.table,
    })
    result.errors++
    return result
  }

  for (const row of (data ?? []) as ClaimedRow[]) {
    const attempts = row.attempt_count ?? 0
    const giveUp = attempts >= MAX_DISPATCH_ATTEMPTS
    const heldForMin = row.claimed_at
      ? Math.round((Date.now() - Date.parse(row.claimed_at)) / 60_000)
      : null

    const reason = giveUp
      ? `Dispatch abandoned after ${attempts} attempt${attempts === 1 ? '' : 's'}: ` +
        `the sender did not finish (timeout, out-of-memory, or a deploy mid-send). Retry to try again.`
      : null

    // Retiring resets attempt_count so a human hitting Retry gets a fresh
    // budget — the retry endpoint re-queues to 'pending' and knows nothing
    // about the counter, so this is what keeps a retried row from being
    // retired again the instant it strands once.
    const patch = giveUp
      ? { status: 'failed', error: reason, ...claimResetPatch() }
      : { status: 'pending', claimed_at: null }

    // CAS on the claim status: if the dispatcher landed its terminal write
    // between our SELECT and here, the row is already sent/failed and this
    // matches nothing. Never clobber a finished row.
    const { data: updated, error: updErr } = await client
      .from(queue.table)
      .update(patch)
      .eq('id', row.id)
      .eq('status', queue.claimStatus)
      .select('id')
      .maybeSingle()

    if (updErr) {
      result.errors++
      await logError('system', 'reap_stale_claim_failed', updErr.message, {
        request_id: requestId,
        table: queue.table,
        row_id: row.id,
        conversation_id: row.conversation_id,
      })
      continue
    }
    if (!updated) {
      result.raced++
      continue
    }

    if (giveUp) {
      result.retired++
      // Loud: a reply we gave up on is a customer who never got answered.
      await logError('system', 'reap_claim_retired', 'Stranded send retired to failed', {
        request_id: requestId,
        table: queue.table,
        row_id: row.id,
        conversation_id: row.conversation_id,
        channel: row.channel,
        attempts,
        held_for_minutes: heldForMin,
      })
      notifyDispatchFailure(client, {
        createdBy: row.created_by,
        conversationId: row.conversation_id,
        channel: row.channel,
        toAddress: row.to_address,
        error: reason ?? 'Dispatch abandoned',
        kind: queue.kind,
        requestId,
      })
    } else {
      result.requeued++
      logInfo('system', 'reap_claim_requeued', 'Stranded send returned to the queue', {
        request_id: requestId,
        table: queue.table,
        row_id: row.id,
        conversation_id: row.conversation_id,
        attempts,
        held_for_minutes: heldForMin,
      })
    }
  }

  return result
}

/**
 * Reclaim every stale claim across both outbound queues.
 *
 * Returns counts rather than throwing; a queue that errors is reported and the
 * other still runs. Safe to run concurrently with the dispatcher — every write
 * is a CAS on the claim status.
 */
export async function reapStaleClaims(
  client: SupabaseClient,
  requestId = 'system'
): Promise<ReapReport> {
  const staleCutoffIso = new Date(Date.now() - STALE_CLAIM_THRESHOLD_MS).toISOString()

  const per_queue: QueueReapResult[] = []
  for (const queue of QUEUES) {
    per_queue.push(await reapQueue(client, queue, staleCutoffIso, requestId))
  }

  return {
    requeued: per_queue.reduce((n, q) => n + q.requeued, 0),
    retired: per_queue.reduce((n, q) => n + q.retired, 0),
    raced: per_queue.reduce((n, q) => n + q.raced, 0),
    errors: per_queue.reduce((n, q) => n + q.errors, 0),
    degraded: per_queue.some((q) => q.degraded),
    per_queue,
  }
}

// ── Health probe ────────────────────────────────────────────────────

/** Await a `head: true` count query. Errors degrade to 0. */
async function countRows(
  query: PromiseLike<{ count: number | null; error: unknown }>
): Promise<number> {
  const { count, error } = await query
  if (error) return 0
  return count ?? 0
}

/**
 * Backlog depth + stranded-row counts for both outbound queues.
 *
 * Read-only and count-only, for the admin health page: the dashboard has a
 * cron dead-man's-switch but nothing showing whether the queues those crons
 * drain are actually draining.
 */
export async function queueHealthSnapshot(client: SupabaseClient): Promise<QueueHealthReport> {
  const nowIso = new Date().toISOString()
  const staleCutoffIso = new Date(Date.now() - STALE_CLAIM_THRESHOLD_MS).toISOString()

  const queues = await Promise.all(
    QUEUES.map(async (queue): Promise<QueueHealth> => {
      const tracked = await supportsClaimTracking(client, queue.table)
      const counted = () => client.from(queue.table).select('id', { count: 'exact', head: true })

      const [pending, due_now, claimed, failed] = await Promise.all([
        countRows(counted().eq('status', 'pending')),
        countRows(counted().eq('status', 'pending').lte(queue.timeField, nowIso)),
        countRows(counted().eq('status', queue.claimStatus)),
        countRows(counted().eq('status', 'failed')),
      ])

      const stranded = tracked
        ? await countRows(
            counted().eq('status', queue.claimStatus).lte('claimed_at', staleCutoffIso)
          )
        : null

      // Oldest due-but-unsent row — the queue's true lag.
      let oldest_due_at: string | null = null
      const { data: oldest } = await client
        .from(queue.table)
        .select(queue.timeField)
        .eq('status', 'pending')
        .lte(queue.timeField, nowIso)
        .order(queue.timeField, { ascending: true })
        .limit(1)
        .maybeSingle()
      if (oldest) {
        oldest_due_at = (oldest as Record<string, string | null>)[queue.timeField] ?? null
      }

      return {
        table: queue.table,
        label: queue.label,
        pending,
        due_now,
        claimed,
        stranded,
        failed,
        oldest_due_at,
        claim_tracking: tracked,
      }
    })
  )

  return {
    queues,
    stale_threshold_minutes: Math.round(STALE_CLAIM_THRESHOLD_MS / 60_000),
    max_dispatch_attempts: MAX_DISPATCH_ATTEMPTS,
    checked_at: nowIso,
  }
}
