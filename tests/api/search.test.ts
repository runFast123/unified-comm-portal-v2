// Tests for GET /api/search — global full-text conversation search.
//
// Covers:
//   * 401 when unauthenticated
//   * empty / whitespace query short-circuits to { results: [] } WITHOUT
//     touching the RPC
//   * 200 happy path returns the rows produced by the search_conversations()
//     RPC, and invokes it with the trimmed query + clamped limit
//   * the RPC is called on the USER-CONTEXT client (so auth.uid() is set and
//     company scoping works) — the service-role client is never constructed
//   * 500 when the underlying RPC errors
//
// Mirrors the RPC-mock style of tests/api/conversation-timeline.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

interface RpcCall {
  fn: string
  args: Record<string, unknown>
}

const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  rpcRows: [] as Array<Record<string, unknown>>,
  rpcError: null as { message: string } | null,
  rpcCalls: [] as RpcCall[],
}

// User-context client: exposes auth.getUser() AND rpc() (the route calls the
// RPC here, NOT on a service-role client).
function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: fixture.user }, error: null }),
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      fixture.rpcCalls.push({ fn, args })
      if (fixture.rpcError) return { data: null, error: fixture.rpcError }
      return { data: fixture.rpcRows, error: null }
    },
  }
}

// If the route ever reached for the service-role client this would throw, so
// the "uses the user client" guarantee is enforced by the test, not just
// asserted. Declared via vi.hoisted() so it is initialized BEFORE the hoisted
// vi.mock factory runs (ESM hoists the route import above a plain top-level
// const, which would otherwise throw a temporal-dead-zone ReferenceError).
const { createServiceRoleClient } = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(async () => {
    throw new Error('service-role client must not be used by /api/search')
  }),
}))

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient,
}))

// Import AFTER mocks.
import { GET } from '@/app/api/search/route'

function makeReq(qs = ''): Request {
  return new Request('http://localhost/api/search' + (qs ? `?${qs}` : ''))
}

beforeEach(() => {
  fixture.user = { id: 'user-1' }
  fixture.rpcRows = []
  fixture.rpcError = null
  fixture.rpcCalls = []
  createServiceRoleClient.mockClear()
})

describe('GET /api/search', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await GET(makeReq('q=hello'))
    expect(res.status).toBe(401)
    expect(fixture.rpcCalls).toHaveLength(0)
  })

  it('empty query returns { results: [] } without calling the RPC', async () => {
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const json = (await res.json()) as { results: unknown[] }
    expect(json.results).toEqual([])
    expect(fixture.rpcCalls).toHaveLength(0)
  })

  it('whitespace-only query is treated as empty', async () => {
    const res = await GET(makeReq('q=%20%20%20'))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { results: unknown[] }
    expect(json.results).toEqual([])
    expect(fixture.rpcCalls).toHaveLength(0)
  })

  it('200 happy path: returns the RPC rows and calls the RPC with trimmed query', async () => {
    fixture.rpcRows = [
      {
        id: 'conv-1',
        account_id: 'acct-1',
        participant_name: 'Jane Doe',
        participant_email: 'jane@example.com',
        channel: 'email',
        status: 'active',
        last_message_at: '2026-05-01T10:00:00Z',
        headline: 'refund for my <mark>broken</mark> order',
        rank: 0.42,
      },
    ]
    const res = await GET(makeReq('q=%20broken%20order%20'))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { results: Array<Record<string, unknown>> }
    expect(json.results).toHaveLength(1)
    expect(json.results[0].id).toBe('conv-1')
    expect(json.results[0].participant_name).toBe('Jane Doe')

    // RPC invoked once, on the user client, with the trimmed query + default limit.
    expect(fixture.rpcCalls).toHaveLength(1)
    expect(fixture.rpcCalls[0].fn).toBe('search_conversations')
    expect(fixture.rpcCalls[0].args.p_query).toBe('broken order')
    expect(fixture.rpcCalls[0].args.p_limit).toBe(30)

    // The service-role client must never be constructed for this route.
    expect(createServiceRoleClient).not.toHaveBeenCalled()
  })

  it('clamps an over-large ?limit to the max', async () => {
    await GET(makeReq('q=hi&limit=9999'))
    expect(fixture.rpcCalls[0].args.p_limit).toBe(50)
  })

  it('honours a valid ?limit', async () => {
    await GET(makeReq('q=hi&limit=10'))
    expect(fixture.rpcCalls[0].args.p_limit).toBe(10)
  })

  it('500 when the underlying RPC errors', async () => {
    fixture.rpcError = { message: 'function search_conversations does not exist' }
    const res = await GET(makeReq('q=hello'))
    expect(res.status).toBe(500)
  })
})
