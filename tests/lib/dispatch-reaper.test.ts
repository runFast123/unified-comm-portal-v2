// Tests for src/lib/dispatch-reaper.ts — recovery of dispatch claims stranded
// by a sender that died mid-send (timeout, OOM, deploy mid-flight, crash).
//
// The two that matter most:
//   * a claim younger than the threshold is NEVER reaped — reaping a live
//     in-flight send would let the next cron run send it again, and a
//     double-send to a customer is worse than the stranding this fixes.
//   * with no claim-tracking columns (migration not yet applied) the reaper
//     writes NOTHING — it must be safe to deploy ahead of its migration.
//
// The mock client models a table as an in-memory row array plus an explicit
// column set, so "before the migration" is a real, testable state rather than
// something we assert around.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// Logger writes to audit_log — stub it out entirely.
vi.mock('@/lib/logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(async () => {}),
}))

const notifySpy = vi.fn()
vi.mock('@/lib/dispatch-notify', () => ({
  notifyDispatchFailure: (...args: unknown[]) => notifySpy(...args),
}))

import {
  reapStaleClaims,
  queueHealthSnapshot,
  supportsClaimTracking,
  STALE_CLAIM_THRESHOLD_MS,
  MAX_DISPATCH_ATTEMPTS,
} from '@/lib/dispatch-reaper'

// ---- In-memory state ----------------------------------------------

interface QueueRow {
  id: string
  conversation_id: string
  account_id: string
  channel: string
  to_address: string | null
  created_by: string | null
  status: string
  error?: string | null
  scheduled_for?: string
  send_at?: string
  claimed_at?: string | null
  attempt_count?: number | null
}

/** Columns each table exposes. Dropping the claim pair models pre-migration. */
const CLAIM_COLS = ['claimed_at', 'attempt_count']
const BASE_COLS = [
  'id',
  'conversation_id',
  'account_id',
  'channel',
  'to_address',
  'created_by',
  'status',
  'error',
]

interface State {
  scheduled_messages: QueueRow[]
  pending_sends: QueueRow[]
  columns: Record<string, string[]>
}

const state: State = {
  scheduled_messages: [],
  pending_sends: [],
  columns: {},
}

const NOW = Date.parse('2026-07-15T12:00:00.000Z')

/** ISO timestamp `minutesAgo` before the frozen clock. */
function ago(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString()
}

/** A claim old enough to be unambiguously stranded. */
const STALE = ago(STALE_CLAIM_THRESHOLD_MS / 60_000 + 5)
/** A claim young enough that its send could still be running. */
const FRESH = ago(1)

function withClaimTracking(): void {
  state.columns = {
    scheduled_messages: [...BASE_COLS, 'scheduled_for', ...CLAIM_COLS],
    pending_sends: [...BASE_COLS, 'send_at', ...CLAIM_COLS],
  }
}

function withoutClaimTracking(): void {
  state.columns = {
    scheduled_messages: [...BASE_COLS, 'scheduled_for'],
    pending_sends: [...BASE_COLS, 'send_at'],
  }
}

function scheduledRow(over: Partial<QueueRow> = {}): QueueRow {
  return {
    id: `sm-${state.scheduled_messages.length + 1}`,
    conversation_id: 'conv-1',
    account_id: 'acct-1',
    channel: 'email',
    to_address: 'customer@example.com',
    created_by: 'user-1',
    status: 'dispatching',
    error: null,
    scheduled_for: ago(30),
    claimed_at: STALE,
    attempt_count: 1,
    ...over,
  }
}

function pendingRow(over: Partial<QueueRow> = {}): QueueRow {
  return {
    id: `ps-${state.pending_sends.length + 1}`,
    conversation_id: 'conv-2',
    account_id: 'acct-1',
    channel: 'email',
    to_address: 'customer@example.com',
    created_by: 'user-1',
    status: 'sending',
    error: null,
    send_at: ago(30),
    claimed_at: STALE,
    attempt_count: 1,
    ...over,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  state.scheduled_messages = []
  state.pending_sends = []
  withClaimTracking()
  notifySpy.mockClear()
})

// ---- Mock client ---------------------------------------------------

type Filter = { kind: 'eq' | 'lte'; col: string; value: unknown }

function applyFilters(rows: QueueRow[], filters: Filter[]): QueueRow[] {
  return rows.filter((r) =>
    filters.every((f) => {
      const v = (r as unknown as Record<string, unknown>)[f.col]
      if (f.kind === 'eq') return v === f.value
      // NULL <= x is never true in SQL — a row with no claimed_at is invisible
      // to the reaper's staleness filter, which is what the migration backfill
      // exists to fix.
      if (f.kind === 'lte') return typeof v === 'string' && v <= String(f.value)
      return true
    })
  )
}

/** Columns referenced by a select list, ignoring `*` and count-only probes. */
function parseCols(cols: string): string[] {
  return cols
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c && c !== '*')
}

function makeClient(): SupabaseClient {
  return {
    from(table: string) {
      const filters: Filter[] = []
      let mode: 'select' | 'update' = 'select'
      let updatePayload: Record<string, unknown> | null = null
      let selectCols = '*'
      let countMode = false
      let headMode = false
      let limitN: number | null = null
      let single = false

      const rows = (): QueueRow[] =>
        (state[table as 'scheduled_messages' | 'pending_sends'] ?? []) as QueueRow[]

      /** PostgREST errors the whole query on an unknown column (42703). */
      const missingColumn = (): string | null => {
        const known = state.columns[table] ?? []
        const referenced = [
          ...parseCols(selectCols),
          ...filters.map((f) => f.col),
          ...Object.keys(updatePayload ?? {}),
        ]
        return referenced.find((c) => !known.includes(c)) ?? null
      }

      const exec = async () => {
        const missing = missingColumn()
        if (missing) {
          return {
            data: null,
            count: null,
            error: {
              code: '42703',
              message: `column ${table}.${missing} does not exist`,
            },
          }
        }

        if (mode === 'update') {
          const matched = applyFilters(rows(), filters)
          for (const r of matched) Object.assign(r, updatePayload ?? {})
          return {
            data: single ? matched[0] ?? null : matched,
            count: matched.length,
            error: null,
          }
        }

        let matched = applyFilters(rows(), filters)
        if (countMode) return { data: null, count: matched.length, error: null }
        if (typeof limitN === 'number') matched = matched.slice(0, limitN)
        if (headMode) return { data: null, count: matched.length, error: null }
        return {
          data: single ? matched[0] ?? null : matched,
          count: matched.length,
          error: null,
        }
      }

      const chain: Record<string, unknown> = {
        select(cols?: string, opts?: { count?: string; head?: boolean }) {
          selectCols = cols ?? '*'
          countMode = !!opts?.count
          headMode = !!opts?.head
          return chain
        },
        update(p: Record<string, unknown>) {
          mode = 'update'
          updatePayload = p
          return chain
        },
        eq(col: string, value: unknown) {
          filters.push({ kind: 'eq', col, value })
          return chain
        },
        lte(col: string, value: unknown) {
          filters.push({ kind: 'lte', col, value })
          return chain
        },
        order() {
          return chain
        },
        limit(n: number) {
          limitN = n
          return chain
        },
        maybeSingle() {
          single = true
          return exec()
        },
        single() {
          single = true
          return exec()
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return exec().then(resolve, reject)
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
}

// ---- supportsClaimTracking -----------------------------------------

describe('supportsClaimTracking', () => {
  it('is true once the claim columns exist', async () => {
    expect(await supportsClaimTracking(makeClient(), 'scheduled_messages')).toBe(true)
    expect(await supportsClaimTracking(makeClient(), 'pending_sends')).toBe(true)
  })

  it('is false before the migration lands', async () => {
    withoutClaimTracking()
    expect(await supportsClaimTracking(makeClient(), 'scheduled_messages')).toBe(false)
    expect(await supportsClaimTracking(makeClient(), 'pending_sends')).toBe(false)
  })
})

// ---- reapStaleClaims -----------------------------------------------

describe('reapStaleClaims', () => {
  it('returns a stale claim to pending and clears claimed_at', async () => {
    state.scheduled_messages = [scheduledRow({ attempt_count: 1 })]

    const report = await reapStaleClaims(makeClient())

    expect(report.requeued).toBe(1)
    expect(report.retired).toBe(0)
    expect(report.degraded).toBe(false)
    const row = state.scheduled_messages[0]
    expect(row.status).toBe('pending')
    expect(row.claimed_at).toBeNull()
    // The attempt the dead sender burned still counts — that's what converges
    // a poison row toward being retired.
    expect(row.attempt_count).toBe(1)
  })

  it('leaves the due time alone so the dispatcher re-picks it immediately', async () => {
    const dueAt = ago(30)
    state.scheduled_messages = [scheduledRow({ scheduled_for: dueAt })]

    await reapStaleClaims(makeClient())

    expect(state.scheduled_messages[0].scheduled_for).toBe(dueAt)
  })

  it('NEVER touches a claim younger than the stale threshold', async () => {
    // The double-send guard: this row's send may still be running.
    state.scheduled_messages = [scheduledRow({ claimed_at: FRESH })]

    const report = await reapStaleClaims(makeClient())

    expect(report.requeued).toBe(0)
    expect(report.retired).toBe(0)
    expect(state.scheduled_messages[0].status).toBe('dispatching')
    expect(state.scheduled_messages[0].claimed_at).toBe(FRESH)
  })

  it('ignores rows that hold no claim', async () => {
    state.scheduled_messages = [
      scheduledRow({ id: 'sm-pending', status: 'pending', claimed_at: null }),
      scheduledRow({ id: 'sm-sent', status: 'sent', claimed_at: STALE }),
      scheduledRow({ id: 'sm-failed', status: 'failed', claimed_at: STALE }),
    ]

    const report = await reapStaleClaims(makeClient())

    expect(report.requeued).toBe(0)
    expect(state.scheduled_messages.map((r) => r.status)).toEqual([
      'pending',
      'sent',
      'failed',
    ])
  })

  it('retires a row to failed once it has burned its attempt budget', async () => {
    state.scheduled_messages = [scheduledRow({ attempt_count: MAX_DISPATCH_ATTEMPTS })]

    const report = await reapStaleClaims(makeClient())

    expect(report.retired).toBe(1)
    expect(report.requeued).toBe(0)
    const row = state.scheduled_messages[0]
    expect(row.status).toBe('failed')
    expect(row.claimed_at).toBeNull()
    // Zeroed so a human hitting Retry gets a fresh budget — the retry endpoint
    // only flips status back to 'pending' and knows nothing about the counter.
    expect(row.attempt_count).toBe(0)
    expect(row.error).toMatch(/abandoned/i)
  })

  it('tells the agent who queued a reply that got retired', async () => {
    state.scheduled_messages = [
      scheduledRow({ attempt_count: MAX_DISPATCH_ATTEMPTS, created_by: 'user-7' }),
    ]

    await reapStaleClaims(makeClient(), 'req-123')

    expect(notifySpy).toHaveBeenCalledTimes(1)
    const notice = notifySpy.mock.calls[0][1] as Record<string, unknown>
    expect(notice.createdBy).toBe('user-7')
    expect(notice.conversationId).toBe('conv-1')
    expect(notice.kind).toBe('scheduled')
    expect(notice.requestId).toBe('req-123')
  })

  it('does not notify when a row is merely re-queued', async () => {
    state.scheduled_messages = [scheduledRow({ attempt_count: 1 })]

    await reapStaleClaims(makeClient())

    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('reaps pending_sends via its own claim status and due column', async () => {
    state.pending_sends = [pendingRow({ attempt_count: 0 })]

    const report = await reapStaleClaims(makeClient())

    expect(report.requeued).toBe(1)
    expect(state.pending_sends[0].status).toBe('pending')
    expect(state.pending_sends[0].claimed_at).toBeNull()
  })

  it('sweeps both queues in one pass', async () => {
    state.scheduled_messages = [scheduledRow({ attempt_count: 0 })]
    state.pending_sends = [pendingRow({ attempt_count: MAX_DISPATCH_ATTEMPTS })]

    const report = await reapStaleClaims(makeClient())

    expect(report.requeued).toBe(1)
    expect(report.retired).toBe(1)
    expect(report.per_queue).toHaveLength(2)
    expect(state.scheduled_messages[0].status).toBe('pending')
    expect(state.pending_sends[0].status).toBe('failed')
  })

  it('loses the CAS rather than clobbering a row the dispatcher just finished', async () => {
    state.scheduled_messages = [scheduledRow()]
    const client = makeClient()
    const realFrom = client.from.bind(client)
    // Simulate the dispatcher landing its terminal write between our SELECT
    // and our UPDATE: the row is 'sent' by the time the CAS runs.
    let selected = false
    ;(client as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const chain = realFrom(table) as unknown as Record<string, unknown>
      const originalUpdate = chain.update as (p: unknown) => unknown
      chain.update = (p: unknown) => {
        if (!selected) {
          selected = true
          state.scheduled_messages[0].status = 'sent'
        }
        return originalUpdate(p)
      }
      return chain
    }

    const report = await reapStaleClaims(client)

    expect(report.raced).toBe(1)
    expect(report.requeued).toBe(0)
    expect(state.scheduled_messages[0].status).toBe('sent')
  })

  describe('before the claim-tracking migration', () => {
    beforeEach(withoutClaimTracking)

    it('writes nothing and reports degraded', async () => {
      state.scheduled_messages = [
        scheduledRow({ claimed_at: undefined, attempt_count: undefined }),
      ]
      state.pending_sends = [pendingRow({ claimed_at: undefined, attempt_count: undefined })]

      const report = await reapStaleClaims(makeClient())

      expect(report.degraded).toBe(true)
      expect(report.requeued).toBe(0)
      expect(report.retired).toBe(0)
      expect(report.errors).toBe(0)
      // Untouched: no claim_at means no way to tell stranded from in-flight,
      // and guessing risks a double-send.
      expect(state.scheduled_messages[0].status).toBe('dispatching')
      expect(state.pending_sends[0].status).toBe('sending')
      expect(notifySpy).not.toHaveBeenCalled()
    })
  })
})

// ---- queueHealthSnapshot -------------------------------------------

describe('queueHealthSnapshot', () => {
  it('counts backlog, in-flight, stranded, and failed rows per queue', async () => {
    state.scheduled_messages = [
      // Due and waiting — the backlog.
      scheduledRow({ id: 'a', status: 'pending', claimed_at: null, scheduled_for: ago(20) }),
      scheduledRow({ id: 'b', status: 'pending', claimed_at: null, scheduled_for: ago(4) }),
      // Queued but not due yet — counts as pending, not as backlog.
      scheduledRow({
        id: 'c',
        status: 'pending',
        claimed_at: null,
        scheduled_for: new Date(NOW + 60 * 60_000).toISOString(),
      }),
      // In flight, fine.
      scheduledRow({ id: 'd', claimed_at: FRESH }),
      // In flight far too long — stranded.
      scheduledRow({ id: 'e', claimed_at: STALE }),
      scheduledRow({ id: 'f', status: 'failed', claimed_at: null }),
    ]

    const report = await queueHealthSnapshot(makeClient())
    const sm = report.queues.find((q) => q.table === 'scheduled_messages')!

    expect(sm.pending).toBe(3)
    expect(sm.due_now).toBe(2)
    expect(sm.claimed).toBe(2)
    expect(sm.stranded).toBe(1)
    expect(sm.failed).toBe(1)
    expect(sm.oldest_due_at).toBe(ago(20))
    expect(sm.claim_tracking).toBe(true)
  })

  it('reports stranded as null (not 0) when claim tracking is unavailable', async () => {
    withoutClaimTracking()
    state.scheduled_messages = [
      scheduledRow({ claimed_at: undefined, attempt_count: undefined }),
    ]

    const report = await queueHealthSnapshot(makeClient())
    const sm = report.queues.find((q) => q.table === 'scheduled_messages')!

    // 0 would read as "all clear" on the dashboard; we genuinely cannot tell.
    expect(sm.stranded).toBeNull()
    expect(sm.claim_tracking).toBe(false)
    // The status counts don't depend on the new columns, so they still work.
    expect(sm.claimed).toBe(1)
  })

  it('reports no oldest_due_at when nothing is overdue', async () => {
    state.scheduled_messages = [
      scheduledRow({
        status: 'pending',
        claimed_at: null,
        scheduled_for: new Date(NOW + 60 * 60_000).toISOString(),
      }),
    ]

    const report = await queueHealthSnapshot(makeClient())
    const sm = report.queues.find((q) => q.table === 'scheduled_messages')!

    expect(sm.due_now).toBe(0)
    expect(sm.oldest_due_at).toBeNull()
  })

  it('covers both queues and echoes the reaper thresholds', async () => {
    const report = await queueHealthSnapshot(makeClient())

    expect(report.queues.map((q) => q.table)).toEqual([
      'scheduled_messages',
      'pending_sends',
    ])
    expect(report.stale_threshold_minutes).toBe(STALE_CLAIM_THRESHOLD_MS / 60_000)
    expect(report.max_dispatch_attempts).toBe(MAX_DISPATCH_ATTEMPTS)
  })
})
