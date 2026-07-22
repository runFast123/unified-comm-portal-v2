// Tests for src/lib/metrics-retention.ts.
//
// metrics_events had NO retention and had grown to 1.1M rows / 349 MB — ~99% of
// the database. The sweep that fixes it runs inside the garbage-collect cron, on
// a table every request writes to, so the properties that matter are the BOUNDS:
//   * never delete anything newer than the cutoff (we'd destroy live telemetry)
//   * bounded rows per DELETE (no long lock on a hot table)
//   * bounded batches per run (the cron stays short; the backlog drains over runs)
//   * never throw — one failing sweep must not stop the cron's other sweeps

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(async () => {}),
}))

import {
  purgeOldMetrics,
  METRICS_RETENTION_DAYS,
  METRICS_PURGE_BATCH,
  METRICS_PURGE_MAX_BATCHES,
} from '@/lib/metrics-retention'

interface Row { id: number; ts: string }

let rows: Row[]
let selectCalls: { cutoff: string; limit: number }[]
let deletedIds: number[]
let failSelect = false
let failDelete = false

function client(): any {
  return {
    from() {
      const state: { cutoff?: string; limit?: number; mode?: 'select' | 'delete' } = {}
      const b: any = {
        select: () => {
          state.mode = 'select'
          return b
        },
        delete: () => {
          state.mode = 'delete'
          return b
        },
        lt: (_col: string, val: string) => {
          state.cutoff = val
          return b
        },
        limit: async (n: number) => {
          state.limit = n
          if (failSelect) return { data: null, error: { message: 'select boom' } }
          selectCalls.push({ cutoff: state.cutoff!, limit: n })
          const older = rows.filter((r) => r.ts < state.cutoff!).slice(0, n)
          return { data: older.map((r) => ({ id: r.id })), error: null }
        },
        in: async (_col: string, ids: number[]) => {
          if (failDelete) return { error: { message: 'delete boom' } }
          deletedIds.push(...ids)
          rows = rows.filter((r) => !ids.includes(r.id))
          return { error: null }
        },
      }
      return b
    },
  }
}

/** n rows, `ageDays` old. */
function makeRows(n: number, ageDays: number, startId = 0): Row[] {
  const ts = new Date(Date.now() - ageDays * 86_400_000).toISOString()
  return Array.from({ length: n }, (_, i) => ({ id: startId + i, ts }))
}

beforeEach(() => {
  rows = []
  selectCalls = []
  deletedIds = []
  failSelect = false
  failDelete = false
})

describe('purgeOldMetrics', () => {
  it('deletes rows older than the retention window', async () => {
    rows = makeRows(10, METRICS_RETENTION_DAYS + 5)
    const res = await purgeOldMetrics(client())
    expect(res.deleted).toBe(10)
    expect(rows).toHaveLength(0)
  })

  it('NEVER deletes rows inside the retention window', async () => {
    // The whole point: recent telemetry is what the dashboards read.
    rows = [...makeRows(5, 1, 0), ...makeRows(5, METRICS_RETENTION_DAYS + 1, 100)]
    const res = await purgeOldMetrics(client())
    expect(res.deleted).toBe(5)
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
  })

  it('is a no-op when nothing is old enough', async () => {
    rows = makeRows(50, 1)
    const res = await purgeOldMetrics(client())
    expect(res.deleted).toBe(0)
    expect(res.batches).toBe(0)
    expect(deletedIds).toHaveLength(0)
  })

  it('bounds each DELETE to the batch size (no long lock)', async () => {
    rows = makeRows(500, METRICS_RETENTION_DAYS + 2)
    await purgeOldMetrics(client(), { batchLimit: 100 })
    // Every select asked for at most the batch size...
    expect(selectCalls.every((c) => c.limit === 100)).toBe(true)
    // ...and the whole set still drained.
    expect(rows).toHaveLength(0)
  })

  it('caps batches per run and reports that more remain', async () => {
    // 10 batches' worth, but only 2 allowed this run.
    rows = makeRows(1000, METRICS_RETENTION_DAYS + 2)
    const res = await purgeOldMetrics(client(), { batchLimit: 100, maxBatches: 2 })
    expect(res.deleted).toBe(200)
    expect(res.batches).toBe(2)
    expect(res.more_remaining).toBe(true)
    expect(rows).toHaveLength(800) // the rest waits for the next run
  })

  it('stops early (more_remaining=false) once drained', async () => {
    rows = makeRows(150, METRICS_RETENTION_DAYS + 2)
    const res = await purgeOldMetrics(client(), { batchLimit: 100, maxBatches: 5 })
    expect(res.deleted).toBe(150)
    expect(res.more_remaining).toBe(false)
  })

  it('never throws on a select failure', async () => {
    failSelect = true
    rows = makeRows(10, METRICS_RETENTION_DAYS + 2)
    const res = await purgeOldMetrics(client())
    expect(res.errors).toBe(1)
    expect(res.deleted).toBe(0)
    expect(rows).toHaveLength(10) // untouched
  })

  it('never throws on a delete failure', async () => {
    failDelete = true
    rows = makeRows(10, METRICS_RETENTION_DAYS + 2)
    const res = await purgeOldMetrics(client())
    expect(res.errors).toBe(1)
    expect(res.deleted).toBe(0)
  })

  it('honours a custom retention window', async () => {
    rows = makeRows(10, 10) // 10 days old
    expect((await purgeOldMetrics(client(), { retentionDays: 30 })).deleted).toBe(0)
    expect((await purgeOldMetrics(client(), { retentionDays: 5 })).deleted).toBe(10)
  })

  it('does NOT stop early when the server caps the select below the batch size', async () => {
    // THE PRODUCTION BUG this pins: PostgREST caps selects at db-max-rows (1000
    // by default) and silently returns fewer rows than requested. Treating that
    // short batch as "drained" limited the sweep to ONE batch per run — observed
    // purging exactly 1000/run instead of batch x maxBatches. Only a ZERO-row
    // select means drained.
    const SERVER_CAP = 50
    rows = makeRows(500, METRICS_RETENTION_DAYS + 2)
    const capped: any = {
      from() {
        const st: { cutoff?: string } = {}
        const b: any = {
          select: () => b,
          delete: () => b,
          lt: (_c: string, v: string) => {
            st.cutoff = v
            return b
          },
          // Asked for `n`, but the server never returns more than SERVER_CAP.
          limit: async (n: number) => {
            selectCalls.push({ cutoff: st.cutoff!, limit: n })
            const older = rows.filter((r) => r.ts < st.cutoff!).slice(0, Math.min(n, SERVER_CAP))
            return { data: older.map((r) => ({ id: r.id })), error: null }
          },
          in: async (_c: string, ids: number[]) => {
            rows = rows.filter((r) => !ids.includes(r.id))
            return { error: null }
          },
        }
        return b
      },
    }

    const res = await purgeOldMetrics(capped, { batchLimit: 200, maxBatches: 4 })
    // 4 batches actually ran despite every one coming back short.
    expect(res.batches).toBe(4)
    expect(res.deleted).toBe(4 * SERVER_CAP)
    expect(rows).toHaveLength(500 - 4 * SERVER_CAP)
  })

  it('ships with sane defaults', () => {
    expect(METRICS_RETENTION_DAYS).toBeGreaterThanOrEqual(7)
    expect(METRICS_PURGE_BATCH).toBeLessThanOrEqual(10_000)
    expect(METRICS_PURGE_MAX_BATCHES).toBeGreaterThanOrEqual(1)
  })
})
