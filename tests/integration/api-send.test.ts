// Integration test: POST /api/send
//
// Smoke-tests the send route end-to-end through the real handler with mocked
// auth + service-role clients + channel senders. Complements the existing
// tests/api/send-dedup.test.ts by covering the auth/scope/channel-mismatch
// branches in addition to the dedup window.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// The send route now gates on action:message.send + channel:*; grant them here.
vi.mock('@/lib/permissions/server', () => ({
  userIdCan: vi.fn(async () => true),
}))

// Stub next/headers to keep getRequestId() out of the request scope.
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

// Channel senders — record + return success.
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

// Rate limiter wrapper — always allow.
vi.mock('@/lib/api-helpers', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api-helpers')>()
  return { ...actual, checkRateLimit: vi.fn(async () => true) }
})

// Fixture state shared across server + service clients.
const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  profile: { role: 'admin' as 'admin' | 'agent', account_id: 'acc-1' } as
    | { role: 'admin' | 'agent'; account_id: string }
    | null,
  conversation: { id: 'conv-1', account_id: 'acc-1', channel: 'email' } as
    | { id: string; account_id: string; channel: string }
    | null,
  dupRow: null as { id: string } | null,
}

function makeServiceClient() {
  // Hand-rolled minimal mock: route uses .from(table).select().eq()...
  // .maybeSingle() and .insert()/.update() chains. We branch on table name.
  return {
    from: (table: string) => {
      const chain: {
        select: () => unknown
        eq: () => unknown
        in: () => unknown
        gte: () => unknown
        limit: () => unknown
        insert: () => unknown
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
        insert: () => chain,
        update: () => chain,
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => {
          if (table === 'users') return { data: fixture.profile, error: null }
          if (table === 'conversations') return { data: fixture.conversation, error: null }
          if (table === 'messages') return { data: fixture.dupRow, error: null }
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

// Import POST AFTER mocks.
import { POST } from '@/app/api/send/route'

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const validEmailBody = {
  channel: 'email' as const,
  account_id: 'acc-1',
  conversation_id: 'conv-1',
  reply_text: 'hello there, this is a unique outbound reply for the test',
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
  fixture.dupRow = null
})

describe('POST /api/send — integration smoke tests', () => {
  it('unauthenticated → 401, sender not invoked', async () => {
    fixture.user = null
    const res = await POST(makeRequest(validEmailBody))
    expect(res.status).toBe(401)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('authenticated admin + valid body → calls sendEmail and returns success', async () => {
    const res = await POST(makeRequest(validEmailBody))
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.success).toBe(true)
    expect(json.deduped).toBeUndefined()
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        to: 'customer@example.com',
        body: validEmailBody.reply_text,
      }),
    )
  })

  it('non-admin attempting to send for an unrelated account → 403', async () => {
    fixture.profile = { role: 'agent', account_id: 'acc-other' }
    const res = await POST(makeRequest(validEmailBody))
    expect(res.status).toBe(403)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('conversation channel does not match request channel → 400', async () => {
    fixture.conversation = { id: 'conv-1', account_id: 'acc-1', channel: 'teams' }
    const res = await POST(makeRequest(validEmailBody))
    expect(res.status).toBe(400)
    const json = (await res.json()) as Record<string, unknown>
    expect(String(json.error)).toMatch(/channel mismatch/i)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('idempotency: dedup row exists in the window → returns deduped:true, sender not invoked', async () => {
    fixture.dupRow = { id: 'msg-existing' }
    const res = await POST(makeRequest(validEmailBody))
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.deduped).toBe(true)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})
