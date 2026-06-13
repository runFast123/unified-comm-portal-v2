// Tests for POST /api/scheduled-messages/retry — re-queue / dismiss a
// FAILED outbound send (pending_sends or scheduled_messages row).
//
// Covers:
//   * 401 when unauthenticated
//   * 400 when id / kind / op are missing or invalid
//   * 429 when rate limited
//   * 404 when the row doesn't exist
//   * 403 when caller lacks account scope
//   * 403 when caller lacks the message.send permission
//   * 400 when the row isn't in 'failed' status
//   * 200 happy retry (both kinds): status='pending', error cleared, time=now
//   * 200 happy dismiss: status='dismissed'
//   * 409 when the conditional UPDATE matches zero rows (another agent raced us)

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- Mocks ---------------------------------------------------------

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

// RBAC permission gate — flip per-test via the fixture.
vi.mock('@/lib/permissions/server', () => ({
  userIdCan: vi.fn(async () => fixture.hasSendPermission),
  userHasPermission: vi.fn(async () => true),
  getEffectivePermissions: vi.fn(async () => new Set<string>()),
}))

vi.mock('@/lib/api-helpers', () => ({
  checkRateLimit: vi.fn(async () => fixture.rateLimitOk),
  verifyAccountAccess: vi.fn(async () => fixture.hasAccountAccess),
}))

type Row = { id: string; account_id: string; status: string } | null

// Tracks state for the mocked rows + UPDATE outcome.
const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  hasSendPermission: true,
  hasAccountAccess: true,
  rateLimitOk: true,
  rows: {
    pending_sends: { id: 'ps-1', account_id: 'acct-1', status: 'failed' } as Row,
    scheduled_messages: { id: 'sm-1', account_id: 'acct-1', status: 'failed' } as Row,
  },
  /** Whether the conditional UPDATE finds a matching row. Tests can flip this
   *  off to simulate another agent retrying/dismissing first. */
  updateMatches: true,
  /** Capture last update for assertions. */
  lastUpdate: null as { table: string; payload: Record<string, unknown> } | null,
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      const ctx: { isUpdate: boolean } = { isUpdate: false }
      const chain: {
        select: () => unknown
        eq: () => unknown
        update: (payload: Record<string, unknown>) => unknown
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>
      } = {
        select: () => chain,
        eq: () => chain,
        update: (payload: Record<string, unknown>) => {
          ctx.isUpdate = true
          fixture.lastUpdate = { table, payload }
          return chain
        },
        maybeSingle: async () => {
          const row = fixture.rows[table as keyof typeof fixture.rows] ?? null
          if (ctx.isUpdate) {
            // Conditional UPDATE returns the row only if it matched.
            return {
              data: fixture.updateMatches && row ? { id: row.id } : null,
              error: null,
            }
          }
          return { data: row, error: null }
        },
      }
      return chain
    },
  }
}

function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: fixture.user }, error: null }),
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

// ---- Import the route AFTER mocks ---------------------------------
import { POST } from '@/app/api/scheduled-messages/retry/route'

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/scheduled-messages/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  fixture.user = { id: 'user-1' }
  fixture.hasSendPermission = true
  fixture.hasAccountAccess = true
  fixture.rateLimitOk = true
  fixture.rows = {
    pending_sends: { id: 'ps-1', account_id: 'acct-1', status: 'failed' },
    scheduled_messages: { id: 'sm-1', account_id: 'acct-1', status: 'failed' },
  }
  fixture.updateMatches = true
  fixture.lastUpdate = null
})

describe('POST /api/scheduled-messages/retry', () => {
  it('rejects when unauthenticated → 401', async () => {
    fixture.user = null
    const res = await POST(makeRequest({ id: 'ps-1', kind: 'pending_send' }))
    expect(res.status).toBe(401)
  })

  it('rejects when id is missing → 400', async () => {
    const res = await POST(makeRequest({ kind: 'pending_send' }))
    expect(res.status).toBe(400)
  })

  it('rejects an unknown kind → 400', async () => {
    const res = await POST(makeRequest({ id: 'ps-1', kind: 'whatever' }))
    expect(res.status).toBe(400)
  })

  it('rejects an unknown op → 400', async () => {
    const res = await POST(makeRequest({ id: 'ps-1', kind: 'pending_send', op: 'explode' }))
    expect(res.status).toBe(400)
  })

  it('rejects malformed JSON body → 400', async () => {
    const req = new Request('http://localhost/api/scheduled-messages/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('rejects when rate limited → 429', async () => {
    fixture.rateLimitOk = false
    const res = await POST(makeRequest({ id: 'ps-1', kind: 'pending_send' }))
    expect(res.status).toBe(429)
  })

  it('returns 404 when the row does not exist', async () => {
    fixture.rows.pending_sends = null
    const res = await POST(makeRequest({ id: 'missing', kind: 'pending_send' }))
    expect(res.status).toBe(404)
  })

  it('returns 403 when the caller lacks account scope', async () => {
    fixture.hasAccountAccess = false
    const res = await POST(makeRequest({ id: 'ps-1', kind: 'pending_send' }))
    expect(res.status).toBe(403)
    // Must NOT have attempted the UPDATE.
    expect(fixture.lastUpdate).toBeNull()
  })

  it('returns 403 when the caller lacks the message.send permission', async () => {
    fixture.hasSendPermission = false
    const res = await POST(makeRequest({ id: 'ps-1', kind: 'pending_send' }))
    expect(res.status).toBe(403)
    expect(fixture.lastUpdate).toBeNull()
  })

  it("returns 400 when the row isn't in 'failed' status", async () => {
    fixture.rows.pending_sends = { id: 'ps-1', account_id: 'acct-1', status: 'sent' }
    const res = await POST(makeRequest({ id: 'ps-1', kind: 'pending_send' }))
    expect(res.status).toBe(400)
    expect(fixture.lastUpdate).toBeNull()
  })

  it('happy retry on a pending_send: re-queues with send_at=now and error cleared', async () => {
    const before = Date.now()
    const res = await POST(makeRequest({ id: 'ps-1', kind: 'pending_send' }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.success).toBe(true)
    expect(json.op).toBe('retry')
    expect(fixture.lastUpdate?.table).toBe('pending_sends')
    const payload = fixture.lastUpdate?.payload as Record<string, unknown>
    expect(payload.status).toBe('pending')
    expect(payload.error).toBeNull()
    expect(typeof payload.send_at).toBe('string')
    expect(new Date(payload.send_at as string).getTime()).toBeGreaterThanOrEqual(before - 1000)
  })

  it('happy retry on a scheduled message: re-queues via scheduled_for', async () => {
    const res = await POST(makeRequest({ id: 'sm-1', kind: 'scheduled' }))
    expect(res.status).toBe(200)
    expect(fixture.lastUpdate?.table).toBe('scheduled_messages')
    const payload = fixture.lastUpdate?.payload as Record<string, unknown>
    expect(payload.status).toBe('pending')
    expect(payload.error).toBeNull()
    expect(typeof payload.scheduled_for).toBe('string')
    expect(payload.send_at).toBeUndefined()
  })

  it("happy dismiss: flips the row to 'dismissed' without touching the send time", async () => {
    const res = await POST(makeRequest({ id: 'ps-1', kind: 'pending_send', op: 'dismiss' }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.op).toBe('dismiss')
    expect(fixture.lastUpdate?.payload).toEqual({ status: 'dismissed' })
  })

  it('returns 409 when another agent retried/dismissed between SELECT and UPDATE', async () => {
    fixture.updateMatches = false
    const res = await POST(makeRequest({ id: 'ps-1', kind: 'pending_send' }))
    expect(res.status).toBe(409)
  })
})
