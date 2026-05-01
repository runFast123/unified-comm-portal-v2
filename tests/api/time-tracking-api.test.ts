// Tests for the per-conversation time-tracking API routes:
//   POST /api/conversations/[id]/time/start
//   POST /api/conversations/[id]/time/heartbeat
//   POST /api/conversations/[id]/time/end
//   POST /api/conversations/[id]/time/manual
//   GET  /api/conversations/[id]/time
//
// Focus: auth gating (401/403/404), body validation, and the happy path
// that demonstrates the helper is wired through correctly. The helper
// itself is exercised in detail by tests/lib/time-tracking.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

interface Conv {
  id: string
  account_id: string
}

interface Entry {
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

const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  conversation: {
    id: 'conv-1',
    account_id: 'acct-1',
  } as Conv | null,
  accessAllowed: true,
  entries: [] as Entry[],
  users: [] as Array<{ id: string; full_name: string | null; email: string | null }>,
  seq: 0,
}

// ---- Mock supabase clients ----------------------------------------

function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: fixture.user }, error: null }),
    },
  }
}

type Filter = { col: string; value: unknown; kind: 'eq' | 'is' | 'in' | 'lte' | 'gt' | 'gte' }

function makeServiceClient() {
  return {
    from(table: string) {
      const filters: Filter[] = []
      let mode: 'select' | 'insert' | 'update' = 'select'
      let payload: Record<string, unknown> | null = null
      let updatePayload: Record<string, unknown> | null = null
      let returnArray = true
      let limitN: number | null = null

      const matches = (row: Record<string, unknown>) =>
        filters.every((f) => {
          const v = row[f.col]
          if (f.kind === 'eq') return v === f.value
          if (f.kind === 'is') return v === f.value
          if (f.kind === 'in') return (f.value as unknown[]).includes(v)
          if (f.kind === 'lte') return typeof v === 'string' && v <= (f.value as string)
          if (f.kind === 'gt') return typeof v === 'string' && v > (f.value as string)
          if (f.kind === 'gte') return typeof v === 'string' && v >= (f.value as string)
          return true
        })

      const exec = async () => {
        if (table === 'conversations') {
          if (mode === 'select') {
            const conv = fixture.conversation
            if (returnArray) return { data: conv ? [conv] : [], error: null }
            return { data: conv ?? null, error: null }
          }
        }
        if (table === 'users') {
          if (mode === 'select') {
            const rows = fixture.users.filter(matches)
            if (returnArray) return { data: rows, error: null }
            return { data: rows[0] ?? null, error: null }
          }
        }
        if (table === 'conversation_time_entries') {
          if (mode === 'select') {
            let rows = fixture.entries.filter((r) => matches(r as unknown as Record<string, unknown>))
            if (typeof limitN === 'number') rows = rows.slice(0, limitN)
            if (returnArray) return { data: rows, error: null }
            return { data: rows[0] ?? null, error: null }
          }
          if (mode === 'insert') {
            fixture.seq++
            const id = `e${fixture.seq}`
            const row: Entry = {
              id,
              conversation_id: String(payload?.conversation_id ?? ''),
              user_id: String(payload?.user_id ?? ''),
              account_id: String(payload?.account_id ?? ''),
              started_at: String(payload?.started_at ?? ''),
              ended_at: (payload?.ended_at as string | null) ?? null,
              duration_seconds: (payload?.duration_seconds as number | null) ?? null,
              source: (payload?.source as 'auto' | 'manual') ?? 'auto',
              notes: (payload?.notes as string | null) ?? null,
              created_at: new Date().toISOString(),
            }
            fixture.entries.push(row)
            return returnArray
              ? { data: [row], error: null }
              : { data: row, error: null }
          }
          if (mode === 'update') {
            const matched = fixture.entries.filter((r) => matches(r as unknown as Record<string, unknown>))
            for (const row of matched) Object.assign(row, updatePayload || {})
            return returnArray
              ? { data: matched, error: null }
              : { data: matched[0] ?? null, error: null }
          }
        }
        return returnArray ? { data: [], error: null } : { data: null, error: null }
      }

      const chain: any = {
        select() {
          return chain
        },
        insert(p: Record<string, unknown>) {
          mode = 'insert'
          payload = p
          return chain
        },
        update(p: Record<string, unknown>) {
          mode = 'update'
          updatePayload = p
          return chain
        },
        eq(col: string, value: unknown) {
          filters.push({ col, value, kind: 'eq' })
          return chain
        },
        is(col: string, value: null) {
          filters.push({ col, value, kind: 'is' })
          return chain
        },
        in(col: string, values: unknown[]) {
          filters.push({ col, value: values, kind: 'in' })
          return chain
        },
        lte(col: string, value: string) {
          filters.push({ col, value, kind: 'lte' })
          return chain
        },
        gt(col: string, value: string) {
          filters.push({ col, value, kind: 'gt' })
          return chain
        },
        gte(col: string, value: string) {
          filters.push({ col, value, kind: 'gte' })
          return chain
        },
        order() {
          return chain
        },
        limit(n: number) {
          limitN = n
          return chain
        },
        async maybeSingle() {
          returnArray = false
          return exec()
        },
        async single() {
          returnArray = false
          return exec()
        },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          return exec().then(resolve, reject)
        },
      }
      return chain
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

vi.mock('@/lib/api-helpers', () => ({
  verifyAccountAccess: vi.fn(async () => fixture.accessAllowed),
  // Always allow rate limiting in tests.
  checkRateLimit: vi.fn(async () => true),
}))

import { POST as startPOST } from '@/app/api/conversations/[id]/time/start/route'
import { POST as heartbeatPOST } from '@/app/api/conversations/[id]/time/heartbeat/route'
import { POST as endPOST } from '@/app/api/conversations/[id]/time/end/route'
import { POST as manualPOST } from '@/app/api/conversations/[id]/time/manual/route'
import { GET as timeGET } from '@/app/api/conversations/[id]/time/route'

function jsonReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function getReq(url: string): Request {
  return new Request(url, { method: 'GET' })
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  fixture.user = { id: 'user-1' }
  fixture.conversation = { id: 'conv-1', account_id: 'acct-1' }
  fixture.accessAllowed = true
  fixture.entries = []
  fixture.users = [
    { id: 'user-1', full_name: 'Agent One', email: 'a1@x' },
    { id: 'user-2', full_name: 'Agent Two', email: 'a2@x' },
  ]
  fixture.seq = 0
})

// ---- /start --------------------------------------------------------

describe('POST /api/conversations/[id]/time/start', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await startPOST(jsonReq('http://l/start', {}), ctx('conv-1'))
    expect(res.status).toBe(401)
  })

  it('404 when conversation missing', async () => {
    fixture.conversation = null
    const res = await startPOST(jsonReq('http://l/start', {}), ctx('conv-1'))
    expect(res.status).toBe(404)
  })

  it('403 when account scope mismatches', async () => {
    fixture.accessAllowed = false
    const res = await startPOST(jsonReq('http://l/start', {}), ctx('conv-1'))
    expect(res.status).toBe(403)
  })

  it('happy path: returns session_id and inserts an open row', async () => {
    const res = await startPOST(jsonReq('http://l/start', {}), ctx('conv-1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session_id: string }
    expect(body.session_id).toBeTruthy()
    expect(fixture.entries.length).toBe(1)
    expect(fixture.entries[0].user_id).toBe('user-1')
    expect(fixture.entries[0].ended_at).toBeNull()
  })
})

// ---- /heartbeat ---------------------------------------------------

describe('POST /api/conversations/[id]/time/heartbeat', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await heartbeatPOST(
      jsonReq('http://l/hb', { session_id: 'x' }),
      ctx('conv-1')
    )
    expect(res.status).toBe(401)
  })

  it('400 when session_id missing', async () => {
    const res = await heartbeatPOST(
      jsonReq('http://l/hb', {}),
      ctx('conv-1')
    )
    expect(res.status).toBe(400)
  })

  it('404 when session not found', async () => {
    const res = await heartbeatPOST(
      jsonReq('http://l/hb', { session_id: 'missing' }),
      ctx('conv-1')
    )
    expect(res.status).toBe(404)
  })

  it('403 when session belongs to a different user', async () => {
    fixture.entries.push(mkEntry({ id: 's1', user_id: 'user-2', conversation_id: 'conv-1' }))
    const res = await heartbeatPOST(
      jsonReq('http://l/hb', { session_id: 's1' }),
      ctx('conv-1')
    )
    expect(res.status).toBe(403)
  })

  it('400 when session belongs to another conversation', async () => {
    fixture.entries.push(mkEntry({ id: 's1', user_id: 'user-1', conversation_id: 'other' }))
    const res = await heartbeatPOST(
      jsonReq('http://l/hb', { session_id: 's1' }),
      ctx('conv-1')
    )
    expect(res.status).toBe(400)
  })

  it('happy path: updates ended_at on an open session', async () => {
    fixture.entries.push(
      mkEntry({
        id: 's1',
        user_id: 'user-1',
        conversation_id: 'conv-1',
        ended_at: null,
      })
    )
    const res = await heartbeatPOST(
      jsonReq('http://l/hb', { session_id: 's1' }),
      ctx('conv-1')
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(fixture.entries[0].ended_at).not.toBeNull()
  })
})

// ---- /end ---------------------------------------------------------

describe('POST /api/conversations/[id]/time/end', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await endPOST(
      jsonReq('http://l/end', { session_id: 'x' }),
      ctx('conv-1')
    )
    expect(res.status).toBe(401)
  })

  it('400 when session_id missing', async () => {
    const res = await endPOST(jsonReq('http://l/end', {}), ctx('conv-1'))
    expect(res.status).toBe(400)
  })

  it('happy path: closes session and computes duration', async () => {
    const startedAt = new Date(Date.now() - 30_000).toISOString()
    fixture.entries.push(
      mkEntry({
        id: 's1',
        user_id: 'user-1',
        conversation_id: 'conv-1',
        ended_at: null,
        started_at: startedAt,
      })
    )
    const res = await endPOST(
      jsonReq('http://l/end', { session_id: 's1' }),
      ctx('conv-1')
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; duration_seconds: number }
    expect(body.ok).toBe(true)
    expect(body.duration_seconds).toBeGreaterThanOrEqual(29)
    expect(fixture.entries[0].ended_at).not.toBeNull()
    expect(fixture.entries[0].duration_seconds).toBe(body.duration_seconds)
  })
})

// ---- /manual ------------------------------------------------------

describe('POST /api/conversations/[id]/time/manual', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await manualPOST(
      jsonReq('http://l/m', { duration_seconds: 60 }),
      ctx('conv-1')
    )
    expect(res.status).toBe(401)
  })

  it('400 when duration is missing or non-positive', async () => {
    const r1 = await manualPOST(
      jsonReq('http://l/m', { duration_seconds: 0 }),
      ctx('conv-1')
    )
    expect(r1.status).toBe(400)
    const r2 = await manualPOST(jsonReq('http://l/m', {}), ctx('conv-1'))
    expect(r2.status).toBe(400)
  })

  it('400 when duration exceeds 24h', async () => {
    const res = await manualPOST(
      jsonReq('http://l/m', { duration_seconds: 24 * 60 * 60 + 1 }),
      ctx('conv-1')
    )
    expect(res.status).toBe(400)
  })

  it('403 when account scope mismatches', async () => {
    fixture.accessAllowed = false
    const res = await manualPOST(
      jsonReq('http://l/m', { duration_seconds: 600 }),
      ctx('conv-1')
    )
    expect(res.status).toBe(403)
  })

  it('inserts a closed manual entry pinned to the caller', async () => {
    const res = await manualPOST(
      jsonReq('http://l/m', {
        duration_seconds: 1500,
        notes: 'reviewed billing thread',
      }),
      ctx('conv-1')
    )
    expect(res.status).toBe(200)
    expect(fixture.entries.length).toBe(1)
    const row = fixture.entries[0]
    expect(row.user_id).toBe('user-1')
    expect(row.source).toBe('manual')
    expect(row.duration_seconds).toBe(1500)
    expect(row.notes).toBe('reviewed billing thread')
    expect(row.ended_at).not.toBeNull()
  })
})

// ---- GET aggregate ------------------------------------------------

describe('GET /api/conversations/[id]/time', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await timeGET(getReq('http://l/time'), ctx('conv-1'))
    expect(res.status).toBe(401)
  })

  it('403 on scope mismatch', async () => {
    fixture.accessAllowed = false
    const res = await timeGET(getReq('http://l/time'), ctx('conv-1'))
    expect(res.status).toBe(403)
  })

  it('returns aggregate with per_user, your_seconds and recent entries', async () => {
    fixture.entries.push(
      mkEntry({
        id: 'a',
        user_id: 'user-1',
        conversation_id: 'conv-1',
        duration_seconds: 600,
      }),
      mkEntry({
        id: 'b',
        user_id: 'user-2',
        conversation_id: 'conv-1',
        duration_seconds: 300,
      })
    )
    const res = await timeGET(getReq('http://l/time'), ctx('conv-1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      total_seconds: number
      your_seconds: number
      per_user: Array<{ user_id: string; user_name: string; total_seconds: number }>
      recent_entries: Array<{ id: string; user_name: string }>
    }
    expect(body.total_seconds).toBe(900)
    expect(body.your_seconds).toBe(600)
    expect(body.per_user.length).toBe(2)
    expect(body.per_user[0]).toMatchObject({
      user_id: 'user-1',
      user_name: 'Agent One',
      total_seconds: 600,
    })
    expect(body.recent_entries.length).toBe(2)
  })
})

// ---- helpers ------------------------------------------------------

function mkEntry(opts: {
  id: string
  user_id: string
  conversation_id: string
  account_id?: string
  started_at?: string
  ended_at?: string | null
  duration_seconds?: number | null
  source?: 'auto' | 'manual'
  notes?: string | null
}): Entry {
  const start = opts.started_at ?? '2026-04-01T00:00:00Z'
  return {
    id: opts.id,
    user_id: opts.user_id,
    conversation_id: opts.conversation_id,
    account_id: opts.account_id ?? 'acct-1',
    started_at: start,
    ended_at: opts.ended_at === undefined ? null : opts.ended_at,
    duration_seconds: opts.duration_seconds ?? null,
    source: opts.source ?? 'auto',
    notes: opts.notes ?? null,
    created_at: start,
  }
}
