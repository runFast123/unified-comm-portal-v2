// Tests for DELETE /api/send/cancel — the Undo-Send cancel endpoint.
//
// Covers:
//   * 401 when unauthenticated
//   * 400 when pending_id is missing
//   * 404 when the row doesn't exist
//   * 403 when caller doesn't own the row
//   * 410 when the row has already moved past 'pending'
//   * 200 happy path: status flipped to 'cancelled'
//   * 410 when the conditional UPDATE matches zero rows (cron raced us)

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- Mocks ---------------------------------------------------------

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

// Tracks state for the mocked pending_sends row + UPDATE outcome.
const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  pendingRow: {
    id: 'pending-1',
    created_by: 'user-1',
    status: 'pending' as 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed',
  } as { id: string; created_by: string; status: string } | null,
  /** Whether the conditional UPDATE finds a matching row. Tests can flip this
   *  off to simulate the cron racing in between SELECT and UPDATE. */
  updateMatches: true,
  /** Capture last update payload for assertions. */
  lastUpdate: null as Record<string, unknown> | null,
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      const ctx: { isUpdate: boolean; updatePayload: Record<string, unknown> | null } = {
        isUpdate: false,
        updatePayload: null,
      }
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
          ctx.updatePayload = payload
          fixture.lastUpdate = payload
          return chain
        },
        maybeSingle: async () => {
          if (table === 'pending_sends') {
            if (ctx.isUpdate) {
              // Conditional UPDATE returns the row only if it matched.
              return {
                data: fixture.updateMatches && fixture.pendingRow ? { id: fixture.pendingRow.id } : null,
                error: null,
              }
            }
            return { data: fixture.pendingRow, error: null }
          }
          return { data: null, error: null }
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

// Logger is fire-and-forget; stub it so we don't need pino.
vi.mock('@/lib/logger', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

// ---- Import the route AFTER mocks ---------------------------------
import { DELETE } from '@/app/api/send/cancel/route'

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/send/cancel', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  fixture.user = { id: 'user-1' }
  fixture.pendingRow = { id: 'pending-1', created_by: 'user-1', status: 'pending' }
  fixture.updateMatches = true
  fixture.lastUpdate = null
})

describe('DELETE /api/send/cancel', () => {
  it('rejects when unauthenticated → 401', async () => {
    fixture.user = null
    const res = await DELETE(makeRequest({ pending_id: 'pending-1' }))
    expect(res.status).toBe(401)
  })

  it('rejects when pending_id is missing → 400', async () => {
    const res = await DELETE(makeRequest({}))
    expect(res.status).toBe(400)
  })

  it('rejects when pending_id is not a string → 400', async () => {
    const res = await DELETE(makeRequest({ pending_id: 123 }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when the row does not exist', async () => {
    fixture.pendingRow = null
    const res = await DELETE(makeRequest({ pending_id: 'missing' }))
    expect(res.status).toBe(404)
  })

  it('returns 403 when the row exists but belongs to a different user', async () => {
    fixture.pendingRow = { id: 'pending-1', created_by: 'someone-else', status: 'pending' }
    const res = await DELETE(makeRequest({ pending_id: 'pending-1' }))
    expect(res.status).toBe(403)
    // Must NOT have attempted the UPDATE.
    expect(fixture.lastUpdate).toBeNull()
  })

  it('returns 410 when the row is already in sending state', async () => {
    fixture.pendingRow = { id: 'pending-1', created_by: 'user-1', status: 'sending' }
    const res = await DELETE(makeRequest({ pending_id: 'pending-1' }))
    expect(res.status).toBe(410)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.status).toBe('sending')
    expect(fixture.lastUpdate).toBeNull()
  })

  it('returns 410 when the row is already sent', async () => {
    fixture.pendingRow = { id: 'pending-1', created_by: 'user-1', status: 'sent' }
    const res = await DELETE(makeRequest({ pending_id: 'pending-1' }))
    expect(res.status).toBe(410)
  })

  it('returns 410 when the row is already cancelled', async () => {
    fixture.pendingRow = { id: 'pending-1', created_by: 'user-1', status: 'cancelled' }
    const res = await DELETE(makeRequest({ pending_id: 'pending-1' }))
    expect(res.status).toBe(410)
  })

  it('happy path: pending row owned by caller → 200 + status flipped to cancelled', async () => {
    const res = await DELETE(makeRequest({ pending_id: 'pending-1' }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.success).toBe(true)
    expect(json.pending_id).toBe('pending-1')
    expect(fixture.lastUpdate).toEqual({ status: 'cancelled' })
  })

  it('returns 410 when the cron raced us between SELECT and UPDATE', async () => {
    // Row looks pending at SELECT time but the conditional UPDATE
    // matches zero rows (cron flipped it to 'sending' first).
    fixture.updateMatches = false
    const res = await DELETE(makeRequest({ pending_id: 'pending-1' }))
    expect(res.status).toBe(410)
  })

  it('rejects malformed JSON body → 400', async () => {
    const req = new Request('http://localhost/api/send/cancel', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    const res = await DELETE(req)
    expect(res.status).toBe(400)
  })
})
