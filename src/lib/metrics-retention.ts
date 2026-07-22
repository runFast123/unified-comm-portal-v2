/**
 * Retention sweep for `metrics_events`.
 *
 * THE PROBLEM THIS SOLVES
 *   metrics_events is written on every cron run, every AI call and every agent
 *   step, and NOTHING ever deleted from it. Measured 2026-07-22: 1,113,098 rows
 *   / 349 MB, growing ~21k rows/day (~195 MB/month) — while the entire rest of
 *   the database was under 5 MB. 45% of it was already older than 30 days.
 *   `retention-purge` only ever covered conversations, so this table grew
 *   without bound: more disk, more autovacuum, and a working set that evicts
 *   the small hot tables (conversations/messages) from cache.
 *
 * WHY BATCHED
 *   A single `DELETE ... WHERE ts < cutoff` over half a million rows is a long
 *   statement holding locks on a table that every request writes to. Instead we
 *   delete a bounded slice per statement and a bounded number of slices per
 *   run, so the sweep is always short and never blocks a metric write. The
 *   backlog drains across runs; steady state is one small batch.
 *
 * NEVER THROWS — it runs inside the garbage-collect cron, where one sweep
 * failing must not stop the others.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logError, logInfo } from '@/lib/logger'

/**
 * How much history to keep. Operational dashboards (the cron dead-man's switch,
 * AI cost/latency panels) only look back hours-to-days; 30 days is already
 * generous. Anything older has no consumer in the app.
 */
export const METRICS_RETENTION_DAYS = 30

/** Rows per DELETE. Small enough that the id list and the lock stay cheap. */
export const METRICS_PURGE_BATCH = 2_000

/** Batches per cron run — bounds total work in one invocation. */
export const METRICS_PURGE_MAX_BATCHES = 5

export interface MetricsPurgeResult {
  deleted: number
  batches: number
  cutoff: string
  errors: number
  /** True when the per-run cap was hit and older rows still remain. */
  more_remaining: boolean
}

export async function purgeOldMetrics(
  client: SupabaseClient,
  opts: { retentionDays?: number; batchLimit?: number; maxBatches?: number } = {}
): Promise<MetricsPurgeResult> {
  const days = opts.retentionDays ?? METRICS_RETENTION_DAYS
  const batch = opts.batchLimit ?? METRICS_PURGE_BATCH
  const maxBatches = opts.maxBatches ?? METRICS_PURGE_MAX_BATCHES
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()

  const result: MetricsPurgeResult = {
    deleted: 0,
    batches: 0,
    cutoff,
    errors: 0,
    more_remaining: false,
  }

  for (let i = 0; i < maxBatches; i++) {
    // Select then delete by id: `delete()` has no LIMIT, and an unbounded
    // delete is exactly what we're avoiding. The (ts DESC) index makes this
    // lookup cheap.
    const { data, error } = await client
      .from('metrics_events')
      .select('id')
      .lt('ts', cutoff)
      .limit(batch)

    if (error) {
      result.errors++
      await logError('system', 'metrics_purge_select_failed', error.message, { cutoff })
      return result
    }

    const ids = (data ?? []).map((r) => (r as { id: number | string }).id)
    if (ids.length === 0) return result // already caught up

    const { error: delErr } = await client.from('metrics_events').delete().in('id', ids)
    if (delErr) {
      result.errors++
      await logError('system', 'metrics_purge_delete_failed', delErr.message, {
        cutoff,
        batch_size: ids.length,
      })
      return result
    }

    result.deleted += ids.length
    result.batches++

    // Short batch => we drained everything older than the cutoff.
    if (ids.length < batch) return result
  }

  // Hit the per-run cap; the next run continues where this one stopped.
  result.more_remaining = true
  logInfo('system', 'metrics_purge_capped', 'Metrics retention sweep hit its per-run cap', {
    deleted: result.deleted,
    cutoff,
  })
  return result
}
