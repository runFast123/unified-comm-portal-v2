// Tests for the Undo-Send branch of POST /api/send.
//
// When the UI passes `delay_ms > 0`, the route should:
//   * NOT call any channel sender
//   * insert a pending_sends row with the right send_at
//   * return { pending_id, send_at } in the body
//
// Also covers the delay_ms cap (MAX_DELAY_MS = 60_000).

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

const { sendEmailMock, sendTeamsMock, sendWhatsAppMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(async () => ({ ok: true, provider_message_id: 'pm-1' })),
  sendTeamsMock: vi.fn(async () => ({ ok: true, provider_message_id: 'pm-1' })),
  sendWhatsAppMock: vi.fn(async () => ({ ok: true, provider_message_id: 'pm-1' })),
}))
vi.mock('@/lib/channel-sender', () => ({
  sendEmail: sendEmailMock,
  sendTeams: sendTeamsMock,
  sendWhatsApp: sendWhatsAppMock,
}))

vi.mock('@/lib/api-helpers', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api-helpers')>()
  return { ...actual, checkRateLimit: vi.fn(async () => true) }
})

vi.mock('@/lib/logger', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  profile: { role: 'admin' as 'admin' | 'agent', account_id: 'acc-1' } as
    | { role: 'admin' | 'agent'; account_id: string }
    | null,
  conversation: { id: 'conv-1', account_id: 'acc-1', channel: 'email' } as
    | { id: string; account_id: string; channel: string }
    | null,
  /** Last payload passed to pending_sends.insert */
  lastPendingInsert: null as Record<string, unknown> | null,
  /** Whether the insert into pending_sends should "succeed" (return row). */
  pendingInsertOk: true,
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      const ctx: { isPendingInsert: boolean; insertPayload: Record<string, unknown> | null } = {
        isPendingInsert: false,
        insertPayload: null,
      }
      const chain: {
        select: () => unknown
        eq: () => unknown
        in: () => unknown
        gte: () => unknown
        limit: () => unknown
        insert: (payload: Record<string, unknown>) => unknown
        update: () => unknown
        single: () => Promise<{ data: unknown; error: unknown }>
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>
        then: (r: (v: { data: unknown; error: unknown }) => unknown) => unknown
      } = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        gte: () => chain,
        limit: () => chain,
        insert: (payload: Record<string, unknown>) => {
          if (table === 'pending_sends') {
            ctx.isPendingInsert = true
            ctx.insertPayload = payload
            fixture.lastPendingInsert = payload
          }
          return chain
        },
        update: () => chain,
        single: async () => {
          if (table === 'pending_sends' && ctx.isPendingInsert) {
            if (!fixture.pendingInsertOk) {
              return { data: null, error: { message: 'simulated insert failure' } }
            }
            return {
              data: { id: 'pending-xyz', send_at: '2026-04-30T12:00:05.000Z' },
              error: null,
            }
          }
          return { data: null, error: null }
        },
        maybeSingle: async () => {
          if (table === 'users') return { data: fixture.profile, error: null }
          if (table === 'conversations') return { data: fixture.conversation, error: null }
          if (table === 'messages') return { data: null, error: null }
          return { data: null, error: null }
        },
        then: (resolve) => resolve({ data: null, error: null }),
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

import { POST } from '@/app/api/send/route'

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const baseBody = {
  channel: 'email' as const,
  account_id: 'acc-1',
  conversation_id: 'conv-1',
  reply_text: 'undo me please',
  to: 'customer@example.com',
  subject: 'Re: ticket',
}

beforeEach(() => {
  sendEmailMock.mockClear()
  sendTeamsMock.mockClear()
  sendWhatsAppMock.mockClear()
  fixture.user = { id: 'user-1' }
  fixture.profile = { role: 'admin', account_id: 'acc-1' }
  fixture.conversation = { id: 'conv-1', account_id: 'acc-1', channel: 'email' }
  fixture.lastPendingInsert = null
  fixture.pendingInsertOk = true
})

describe('POST /api/send — Undo-Send (delay_ms) branch', () => {
  it('with delay_ms=5000: enqueues pending row, does NOT call channel sender', async () => {
    const res = await POST(makeRequest({ ...baseBody, delay_ms: 5000 }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.success).toBe(true)
    expect(json.pending).toBe(true)
    expect(json.pending_id).toBe('pending-xyz')
    expect(json.send_at).toBe('2026-04-30T12:00:05.000Z')
    expect(sendEmailMock).not.toHaveBeenCalled()

    // Verify the insert payload carried the right fields.
    expect(fixture.lastPendingInsert).toMatchObject({
      conversation_id: 'conv-1',
      account_id: 'acc-1',
      channel: 'email',
      reply_text: 'undo me please',
      to_address: 'customer@example.com',
      subject: 'Re: ticket',
      created_by: 'user-1',
      status: 'pending',
    })
    expect(fixture.lastPendingInsert?.send_at).toEqual(expect.any(String))
  })

  it('with delay_ms omitted: behaves like a normal immediate send', async () => {
    const res = await POST(makeRequest(baseBody))
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.success).toBe(true)
    expect(json.pending).toBeUndefined()
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })

  it('with delay_ms=0: also behaves like an immediate send (back-compat)', async () => {
    const res = await POST(makeRequest({ ...baseBody, delay_ms: 0 }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.success).toBe(true)
    expect(json.pending).toBeUndefined()
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })

  it('rejects delay_ms larger than the 60s cap → 400', async () => {
    const res = await POST(makeRequest({ ...baseBody, delay_ms: 120_000 }))
    expect(res.status).toBe(400)
    const json = (await res.json()) as Record<string, unknown>
    expect(String(json.error)).toMatch(/delay_ms exceeds max/i)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('returns 500 when the pending_sends insert fails', async () => {
    fixture.pendingInsertOk = false
    const res = await POST(makeRequest({ ...baseBody, delay_ms: 5000 }))
    expect(res.status).toBe(500)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})
