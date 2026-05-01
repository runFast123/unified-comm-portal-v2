// API tests for CSAT routes.
//
// Covers:
//   * POST /api/csat/[token] — public; valid token + rating succeeds, second
//     submit returns 409, invalid token returns 401, expired returns 410.
//   * GET /api/csat/aggregate — auth required, scope authorization.
//   * Auto-send hook fires only when company.csat_enabled and conditions
//     met; never throws even when DB calls fail.
//   * POST /api/conversations/[id]/csat/send — manual trigger gating.

import { describe, it, expect, beforeEach, vi } from 'vitest'

beforeEach(() => {
  process.env.WEBHOOK_SECRET = 'test-secret-456'
})

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

// ─── Shared fixture state across all suites ──────────────────────────

interface SurveyFixture {
  id: string
  responded_at: string | null
  rating: number | null
  expires_at: string
  account_id: string
  agent_user_id: string | null
  conversation_id: string
  customer_email: string | null
  feedback: string | null
  sent_at: string
  token: string
}

const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  profile: {
    id: 'user-1',
    email: 'a@example.com',
    full_name: 'A',
    role: 'company_admin',
    account_id: null,
    company_id: 'co-1',
  } as any,
  surveys: [] as SurveyFixture[],
  accounts: [] as Array<{ id: string; company_id: string | null }>,
  companies: [] as Array<{
    id: string
    name: string
    csat_enabled: boolean | null
    csat_email_subject: string | null
    csat_email_body: string | null
  }>,
  conversations: [] as Array<{
    id: string
    account_id: string
    participant_email: string | null
    participant_name: string | null
    assigned_to: string | null
    status: string
    secondary_status: string | null
    secondary_status_color: string | null
  }>,
  inserts: [] as Array<{ table: string; payload: any }>,
  updates: [] as Array<{ table: string; payload: any; filters: any[] }>,
  rateAllow: true,
  emailResult: { ok: true } as { ok: boolean; error?: string },
  accessAllowed: true,
}

let nextSurveyId = 100

function resetFixture() {
  fixture.user = { id: 'user-1' }
  fixture.profile = {
    id: 'user-1',
    email: 'a@example.com',
    full_name: 'A',
    role: 'company_admin',
    account_id: null,
    company_id: 'co-1',
  }
  fixture.surveys = []
  fixture.accounts = [{ id: 'acct-1', company_id: 'co-1' }]
  fixture.companies = [
    { id: 'co-1', name: 'Acme', csat_enabled: true, csat_email_subject: null, csat_email_body: null },
  ]
  fixture.conversations = [
    {
      id: 'conv-1',
      account_id: 'acct-1',
      participant_email: 'cust@x.example',
      participant_name: 'Cust',
      assigned_to: 'agent-7',
      status: 'active',
      secondary_status: null,
      secondary_status_color: null,
    },
  ]
  fixture.inserts = []
  fixture.updates = []
  fixture.rateAllow = true
  fixture.emailResult = { ok: true }
  fixture.accessAllowed = true
  nextSurveyId = 100
}

function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: fixture.user }, error: null }),
    },
  }
}

function makeServiceClient() {
  return {
    from(table: string) {
      const builder: any = {
        _table: table,
        _filters: [] as Array<{ col: string; val: any }>,
        _isFilters: [] as Array<{ col: string; val: any }>,
        _selectCols: '*',
        _op: null as 'insert' | 'update' | 'select' | null,
        _insertPayload: null as any,
        _updatePayload: null as any,
        _limit: null as number | null,
        select(cols?: string) {
          builder._selectCols = cols ?? '*'
          if (builder._op === null) builder._op = 'select'
          return builder
        },
        insert(payload: any) {
          builder._op = 'insert'
          builder._insertPayload = payload
          return builder
        },
        update(payload: any) {
          builder._op = 'update'
          builder._updatePayload = payload
          return builder
        },
        eq(col: string, val: any) {
          builder._filters.push({ col, val })
          return builder
        },
        is(col: string, val: any) {
          builder._isFilters.push({ col, val })
          return builder
        },
        gte() {
          return builder
        },
        in(col: string, vals: any[]) {
          builder._filters.push({ col, val: vals, _isIn: true })
          return builder
        },
        order() {
          return builder
        },
        limit(n: number) {
          builder._limit = n
          return builder
        },
        async maybeSingle() {
          const all = pool(table)
          const found = all.find((r: any) =>
            builder._filters.every((f: any) =>
              f._isIn ? f.val.includes(r[f.col]) : r[f.col] === f.val
            )
          )
          // Return a SHALLOW COPY so subsequent fake `update()` calls
          // (which mutate the source row in place) don't retroactively
          // change values the route already read.
          return { data: found ? { ...found } : null, error: null }
        },
        async single() {
          if (builder._op === 'insert' && table === 'csat_surveys') {
            const id = `srv-${nextSurveyId++}`
            const row: SurveyFixture = {
              id,
              conversation_id: builder._insertPayload.conversation_id,
              account_id: builder._insertPayload.account_id,
              agent_user_id: builder._insertPayload.agent_user_id ?? null,
              customer_email: builder._insertPayload.customer_email ?? null,
              token: builder._insertPayload.token,
              responded_at: null,
              rating: null,
              feedback: null,
              expires_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
              sent_at: new Date().toISOString(),
            }
            fixture.surveys.push(row)
            fixture.inserts.push({ table, payload: builder._insertPayload })
            return { data: { id }, error: null }
          }
          return { data: null, error: { message: 'not implemented' } }
        },
        then(resolve: any) {
          if (builder._op === 'select') {
            const all = pool(table)
            let out = all.filter((r: any) =>
              builder._filters.every((f: any) =>
                f._isIn ? f.val.includes(r[f.col]) : r[f.col] === f.val
              )
            )
            if (builder._limit !== null) out = out.slice(0, builder._limit)
            return resolve({ data: out, error: null })
          }
          if (builder._op === 'update') {
            const all = pool(table)
            const matches = all.filter((r: any) => {
              if (
                !builder._filters.every((f: any) =>
                  f._isIn ? f.val.includes(r[f.col]) : r[f.col] === f.val
                )
              )
                return false
              if (!builder._isFilters.every((f: any) => r[f.col] === f.val)) return false
              return true
            })
            for (const m of matches) Object.assign(m, builder._updatePayload)
            fixture.updates.push({
              table,
              payload: builder._updatePayload,
              filters: [...builder._filters],
            })
            return resolve({
              data: builder._selectCols === '*' ? null : matches.map((r: any) => ({ id: r.id })),
              error: null,
            })
          }
          if (builder._op === 'insert') {
            // audit_log etc — record + ack.
            fixture.inserts.push({ table, payload: builder._insertPayload })
            return resolve({ data: null, error: null })
          }
          return resolve({ data: null, error: null })
        },
      }
      return builder
    },
  }
}

function pool(table: string): any[] {
  switch (table) {
    case 'csat_surveys':
      return fixture.surveys
    case 'accounts':
      return fixture.accounts
    case 'companies':
      return fixture.companies
    case 'conversations':
      return fixture.conversations
    case 'users':
      return [fixture.profile]
    default:
      return []
  }
}

// ─── Module mocks ─────────────────────────────────────────────────────

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

vi.mock('@/lib/api-helpers', async () => {
  const actual = await vi.importActual<any>('@/lib/api-helpers')
  return {
    ...actual,
    checkRateLimit: vi.fn(async () => fixture.rateAllow),
    verifyAccountAccess: vi.fn(async () => fixture.accessAllowed),
  }
})

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<any>('@/lib/auth')
  return {
    ...actual,
    getCurrentUser: vi.fn(async () => fixture.profile),
  }
})

vi.mock('@/lib/channel-sender', () => ({
  sendEmail: vi.fn(async () => fixture.emailResult),
}))

// Webhook-dispatcher stub: another agent added an `after()` call wrapping
// fireWebhook in the status route. We stub it so the test process doesn't
// actually try to fan-out any webhooks.
vi.mock('@/lib/webhook-dispatcher', () => ({
  fireWebhook: vi.fn(async () => undefined),
}))

// Stub `after` from next/server to a synchronous executor so the CSAT
// hook test can observe side-effects.
vi.mock('next/server', async () => {
  const actual = await vi.importActual<any>('next/server')
  return {
    ...actual,
    after: (fn: () => void | Promise<void>) => Promise.resolve(fn()).catch(() => {}),
  }
})

// ─── Imports under test (after mocks) ─────────────────────────────────

import { POST as POST_PUBLIC } from '@/app/api/csat/[token]/route'
import { POST as POST_SEND } from '@/app/api/conversations/[id]/csat/send/route'
import { GET as GET_AGGREGATE } from '@/app/api/csat/aggregate/route'
import { POST as POST_STATUS } from '@/app/api/conversations/[id]/status/route'
import { mintSurveyToken } from '@/lib/csat'

function jsonReq(url: string, body?: unknown, method: string = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  resetFixture()
  vi.clearAllMocks()
})

// ─── Public POST /api/csat/[token] ────────────────────────────────────

describe('POST /api/csat/[token]', () => {
  it('401 when token is invalid', async () => {
    const res = await POST_PUBLIC(
      jsonReq('http://localhost/api/csat/invalid', { rating: 5 }),
      { params: Promise.resolve({ token: 'garbage.sig' }) }
    )
    expect(res.status).toBe(401)
  })

  it('400 when rating is out of range', async () => {
    fixture.surveys.push({
      id: 'srv-1',
      conversation_id: 'c1',
      account_id: 'a1',
      agent_user_id: null,
      customer_email: null,
      token: 'x',
      responded_at: null,
      rating: null,
      feedback: null,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    })
    const tok = mintSurveyToken('srv-1')
    const res = await POST_PUBLIC(
      jsonReq('http://localhost/api/csat/' + tok, { rating: 9 }),
      { params: Promise.resolve({ token: tok }) }
    )
    expect(res.status).toBe(400)
  })

  it('200 first submit, 409 second submit, persists rating', async () => {
    fixture.surveys.push({
      id: 'srv-1',
      conversation_id: 'c1',
      account_id: 'a1',
      agent_user_id: null,
      customer_email: null,
      token: 'x',
      responded_at: null,
      rating: null,
      feedback: null,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    })
    const tok = mintSurveyToken('srv-1')
    const r1 = await POST_PUBLIC(
      jsonReq('http://localhost/api/csat/' + tok, { rating: 5, feedback: 'great' }),
      { params: Promise.resolve({ token: tok }) }
    )
    expect(r1.status).toBe(200)
    expect(fixture.surveys[0].rating).toBe(5)
    expect(fixture.surveys[0].feedback).toBe('great')
    expect(fixture.surveys[0].responded_at).toBeTruthy()

    const r2 = await POST_PUBLIC(
      jsonReq('http://localhost/api/csat/' + tok, { rating: 4 }),
      { params: Promise.resolve({ token: tok }) }
    )
    expect(r2.status).toBe(409)
  })

  it('410 when expired', async () => {
    fixture.surveys.push({
      id: 'srv-1',
      conversation_id: 'c1',
      account_id: 'a1',
      agent_user_id: null,
      customer_email: null,
      token: 'x',
      responded_at: null,
      rating: null,
      feedback: null,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    })
    const tok = mintSurveyToken('srv-1')
    const res = await POST_PUBLIC(
      jsonReq('http://localhost/api/csat/' + tok, { rating: 5 }),
      { params: Promise.resolve({ token: tok }) }
    )
    expect(res.status).toBe(410)
  })

  it('429 when rate limit blocks', async () => {
    fixture.rateAllow = false
    const tok = mintSurveyToken('srv-1')
    const res = await POST_PUBLIC(
      jsonReq('http://localhost/api/csat/' + tok, { rating: 5 }),
      { params: Promise.resolve({ token: tok }) }
    )
    expect(res.status).toBe(429)
  })
})

// ─── Auth-gated GET /api/csat/aggregate ───────────────────────────────

describe('GET /api/csat/aggregate', () => {
  it('401 unauthenticated', async () => {
    fixture.user = null
    const res = await GET_AGGREGATE(jsonReq('http://localhost/api/csat/aggregate?scope=company&id=co-1', undefined, 'GET'))
    expect(res.status).toBe(401)
  })

  it('400 missing scope', async () => {
    const res = await GET_AGGREGATE(jsonReq('http://localhost/api/csat/aggregate?id=co-1', undefined, 'GET'))
    expect(res.status).toBe(400)
  })

  it('403 when scope=company id is for a different company', async () => {
    const res = await GET_AGGREGATE(jsonReq('http://localhost/api/csat/aggregate?scope=company&id=co-OTHER', undefined, 'GET'))
    expect(res.status).toBe(403)
  })

  it('200 returns aggregate for own company', async () => {
    fixture.surveys.push({
      id: 'srv-1',
      conversation_id: 'c1',
      account_id: 'acct-1',
      agent_user_id: null,
      customer_email: null,
      token: 'x',
      responded_at: new Date().toISOString(),
      rating: 5,
      feedback: null,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    })
    const res = await GET_AGGREGATE(jsonReq('http://localhost/api/csat/aggregate?scope=company&id=co-1', undefined, 'GET'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.aggregate.total_responded).toBe(1)
    expect(j.aggregate.avg_rating).toBe(5)
  })
})

// ─── Auto-send hook via /api/conversations/[id]/status ────────────────

describe('CSAT auto-send hook on status=resolved', () => {
  it('fires sendEmail when company csat_enabled and conditions met', async () => {
    const sender = await import('@/lib/channel-sender')
    const sendEmail = sender.sendEmail as unknown as ReturnType<typeof vi.fn>
    sendEmail.mockClear()

    const res = await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', { status: 'resolved' }),
      { params: Promise.resolve({ id: 'conv-1' }) }
    )
    expect(res.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(fixture.surveys.length).toBe(1)
    expect(fixture.surveys[0].agent_user_id).toBe('agent-7')
  })

  it('does NOT fire when company.csat_enabled is false', async () => {
    fixture.companies[0].csat_enabled = false
    const sender = await import('@/lib/channel-sender')
    const sendEmail = sender.sendEmail as unknown as ReturnType<typeof vi.fn>
    sendEmail.mockClear()

    await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', { status: 'resolved' }),
      { params: Promise.resolve({ id: 'conv-1' }) }
    )
    expect(sendEmail).not.toHaveBeenCalled()
    expect(fixture.surveys.length).toBe(0)
  })

  it('does NOT fire when conversation has no participant_email', async () => {
    fixture.conversations[0].participant_email = null
    const sender = await import('@/lib/channel-sender')
    const sendEmail = sender.sendEmail as unknown as ReturnType<typeof vi.fn>
    sendEmail.mockClear()

    await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', { status: 'resolved' }),
      { params: Promise.resolve({ id: 'conv-1' }) }
    )
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('does NOT fire when status was already resolved (no transition)', async () => {
    fixture.conversations[0].status = 'resolved'
    const sender = await import('@/lib/channel-sender')
    const sendEmail = sender.sendEmail as unknown as ReturnType<typeof vi.fn>
    sendEmail.mockClear()

    await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', { status: 'resolved' }),
      { params: Promise.resolve({ id: 'conv-1' }) }
    )
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('skips when a CSAT was sent for the same conversation in last 30 days', async () => {
    fixture.surveys.push({
      id: 'srv-old',
      conversation_id: 'conv-1',
      account_id: 'acct-1',
      agent_user_id: null,
      customer_email: null,
      token: 'x',
      responded_at: null,
      rating: null,
      feedback: null,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    })
    const sender = await import('@/lib/channel-sender')
    const sendEmail = sender.sendEmail as unknown as ReturnType<typeof vi.fn>
    sendEmail.mockClear()

    await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', { status: 'resolved' }),
      { params: Promise.resolve({ id: 'conv-1' }) }
    )
    expect(sendEmail).not.toHaveBeenCalled()
    // Should still only be the one pre-existing survey
    expect(fixture.surveys.length).toBe(1)
  })

  it('CSAT failure must not block the status update', async () => {
    const sender = await import('@/lib/channel-sender')
    const sendEmail = sender.sendEmail as unknown as ReturnType<typeof vi.fn>
    sendEmail.mockImplementationOnce(async () => ({ ok: false, error: 'smtp died' }))

    const res = await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', { status: 'resolved' }),
      { params: Promise.resolve({ id: 'conv-1' }) }
    )
    expect(res.status).toBe(200)
    expect(fixture.conversations[0].status).toBe('resolved')
  })
})

// ─── Manual /api/conversations/[id]/csat/send ─────────────────────────

describe('POST /api/conversations/[id]/csat/send', () => {
  it('401 unauthenticated', async () => {
    fixture.user = null
    const res = await POST_SEND(
      jsonReq('http://localhost/api/conversations/conv-1/csat/send'),
      { params: Promise.resolve({ id: 'conv-1' }) }
    )
    expect(res.status).toBe(401)
  })

  it('404 when conversation not found', async () => {
    const res = await POST_SEND(
      jsonReq('http://localhost/api/conversations/nope/csat/send'),
      { params: Promise.resolve({ id: 'nope' }) }
    )
    expect(res.status).toBe(404)
  })

  it('403 when account access denied', async () => {
    fixture.accessAllowed = false
    const res = await POST_SEND(
      jsonReq('http://localhost/api/conversations/conv-1/csat/send'),
      { params: Promise.resolve({ id: 'conv-1' }) }
    )
    expect(res.status).toBe(403)
  })

  it('422 when conversation has no email', async () => {
    fixture.conversations[0].participant_email = null
    const res = await POST_SEND(
      jsonReq('http://localhost/api/conversations/conv-1/csat/send'),
      { params: Promise.resolve({ id: 'conv-1' }) }
    )
    expect(res.status).toBe(422)
  })

  it('200 happy path mints survey + sends email', async () => {
    const sender = await import('@/lib/channel-sender')
    const sendEmail = sender.sendEmail as unknown as ReturnType<typeof vi.fn>
    sendEmail.mockClear()

    const res = await POST_SEND(
      jsonReq('http://localhost/api/conversations/conv-1/csat/send'),
      { params: Promise.resolve({ id: 'conv-1' }) }
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.survey_id).toBeTruthy()
    expect(typeof j.public_url).toBe('string')
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const callArgs = sendEmail.mock.calls[0][0]
    // Default subject should land
    expect(callArgs.subject).toBe('How did we do?')
    expect(callArgs.body).toContain('/csat/')
  })
})
