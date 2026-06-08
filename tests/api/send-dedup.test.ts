// Tests for the 15s idempotency window on POST /api/send.
//
// Fully wiring up `src/app/api/send/route.ts` requires mocking NextResponse,
// the auth client, the service-role client, channel senders, and the rate
// limiter — doable but heavy. For the initial safety net we stub out all of
// those and exercise the dedup guard end-to-end; deeper coverage (attachment
// ownership, audit logging) is captured as `it.todo` markers below.

import { vi } from 'vitest'

// The send route now gates on action:message.send + channel:*; grant them here.
vi.mock('@/lib/permissions/server', () => ({
  userIdCan: vi.fn(async () => true),
}))

// ---- Mocks ---------------------------------------------------------

// Freeze the clock so the dedup window check is deterministic.
const NOW = new Date('2026-04-24T12:00:00Z').getTime()

let currentNow = NOW
vi.spyOn(Date, 'now').mockImplementation(() => currentNow)

// Channel senders — record the call and return success.
// vi.hoisted so these are available when vi.mock's hoisted factory runs.
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

// Rate limiter wrapper — always allow so the dedup path is reachable.
vi.mock('@/lib/api-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-helpers')>(
    '@/lib/api-helpers',
  )
  return { ...actual, checkRateLimit: vi.fn(async () => true) }
})

// Mutable fixtures the mocked supabase clients read from.
const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  profile: { role: 'admin', account_id: 'acc-1' } as
    | { role: string; account_id: string }
    | null,
  conversation: { id: 'conv-1', account_id: 'acc-1', channel: 'email' } as
    | { id: string; account_id: string; channel: string }
    | null,
  dupRow: null as { id: string } | null,
}

// Minimal service-role client — we only need the `from().select()...maybeSingle()`
// paths used by the route, plus `.insert()` / `.update()` no-ops.
function makeServiceClient() {
  return {
    from: (table: string) => {
      const chain: any = {
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
          if (table === 'conversations')
            return { data: fixture.conversation, error: null }
          if (table === 'messages') return { data: fixture.dupRow, error: null }
          return { data: null, error: null }
        },
        then: (resolve: any) => resolve({ data: null, error: null }),
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
  reply_text: 'hello there',
  to: 'customer@example.com',
  subject: 'Re: ticket',
}

describe('POST /api/send — dedup guard', () => {
  beforeEach(() => {
    sendEmailMock.mockClear()
    sendTeamsMock.mockClear()
    sendWhatsAppMock.mockClear()
    fixture.dupRow = null
    currentNow = NOW
    fixture.user = { id: 'user-1' }
    fixture.profile = { role: 'admin', account_id: 'acc-1' }
    fixture.conversation = { id: 'conv-1', account_id: 'acc-1', channel: 'email' }
  })

  it('first send: no duplicate row → sender is called', async () => {
    const res = await POST(makeRequest(validEmailBody))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.deduped).toBeUndefined()
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })

  it('second identical send within 15s: deduped=true, sender NOT called', async () => {
    fixture.dupRow = { id: 'msg-existing' }
    const res = await POST(makeRequest(validEmailBody))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.deduped).toBe(true)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('rejects when unauthenticated', async () => {
    fixture.user = null
    const res = await POST(makeRequest(validEmailBody))
    expect(res.status).toBe(401)
  })

  it('rejects when channel mismatches the conversation', async () => {
    fixture.conversation = { id: 'conv-1', account_id: 'acc-1', channel: 'teams' }
    const res = await POST(makeRequest(validEmailBody))
    expect(res.status).toBe(400)
  })

  it.todo('attachment path not owned by caller → 403')
  it.todo('non-admin caller whose account_id differs from body.account_id → 403')
  it.todo('after 15s window expires, second send goes through normally')
})
