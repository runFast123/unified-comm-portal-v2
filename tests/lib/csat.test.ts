// Unit tests for src/lib/csat.ts.
//
// Covers:
//   * mintSurveyToken / verifySurveyToken roundtrip + tamper rejection
//   * createSurvey writes a row and updates with the real token
//   * recordResponse one-time semantics (404 / 410 / 409 / 400)
//   * companyCSATAggregate / agentCSATAggregate roll-up math
//   * publicSurveyUrl uses NEXT_PUBLIC_APP_URL when set

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Pin WEBHOOK_SECRET for deterministic token tests.
beforeEach(() => {
  process.env.WEBHOOK_SECRET = 'test-secret-123'
})

import {
  mintSurveyToken,
  verifySurveyToken,
  publicSurveyUrl,
  createSurvey,
  recordResponse,
  companyCSATAggregate,
  agentCSATAggregate,
  __test,
} from '@/lib/csat'

describe('csat token mint/verify', () => {
  it('roundtrips a UUID-like surveyId', () => {
    const id = 'abcd1234-aaaa-bbbb-cccc-1111deadbeef'
    const tok = mintSurveyToken(id)
    expect(tok.startsWith(id + '.')).toBe(true)
    expect(verifySurveyToken(tok)).toBe(id)
  })

  it('rejects a token with a tampered surveyId', () => {
    const id = 'survey-1'
    const tok = mintSurveyToken(id)
    const tampered = tok.replace(/^survey-1/, 'survey-2')
    expect(verifySurveyToken(tampered)).toBeNull()
  })

  it('rejects a token with a tampered signature', () => {
    const id = 'survey-1'
    const tok = mintSurveyToken(id)
    const dot = tok.indexOf('.')
    const tampered = tok.slice(0, dot + 1) + 'x'.repeat(tok.length - dot - 1)
    expect(verifySurveyToken(tampered)).toBeNull()
  })

  it('rejects garbage / empty / no-dot tokens', () => {
    expect(verifySurveyToken('')).toBeNull()
    expect(verifySurveyToken(null)).toBeNull()
    expect(verifySurveyToken(undefined)).toBeNull()
    expect(verifySurveyToken('nodot')).toBeNull()
    expect(verifySurveyToken('.justasig')).toBeNull()
    expect(verifySurveyToken('id.')).toBeNull()
  })

  it('returns null when WEBHOOK_SECRET is missing', () => {
    delete process.env.WEBHOOK_SECRET
    expect(verifySurveyToken('any.thing')).toBeNull()
  })

  it('publicSurveyUrl uses NEXT_PUBLIC_APP_URL when set', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/'
    expect(publicSurveyUrl('abc.def')).toBe('https://app.example.com/csat/abc.def')
    delete process.env.NEXT_PUBLIC_APP_URL
  })
})

// ─── createSurvey + recordResponse against a fake supabase ────────────

interface FakeRow {
  id: string
  conversation_id: string
  account_id: string
  agent_user_id: string | null
  customer_email: string | null
  token: string
  responded_at: string | null
  rating: number | null
  feedback: string | null
  expires_at: string
  sent_at: string
}

function makeFakeClient(initial: FakeRow[] = []) {
  const rows: FakeRow[] = [...initial]
  let nextId = 1
  return {
    rows,
    from(table: string) {
      if (table !== 'csat_surveys') {
        throw new Error(`unexpected table ${table}`)
      }
      const builder: any = {
        _filters: [] as Array<{ col: keyof FakeRow; val: any }>,
        _isFilters: [] as Array<{ col: keyof FakeRow; val: any }>,
        _selectCols: '*',
        _insertPayload: null as any,
        _updatePayload: null as any,
        _op: null as 'insert' | 'update' | 'select' | null,
        select(cols?: string) {
          builder._selectCols = cols ?? '*'
          if (builder._op === null) builder._op = 'select'
          return builder
        },
        insert(payload: Record<string, unknown>) {
          builder._op = 'insert'
          builder._insertPayload = payload
          return builder
        },
        update(payload: Record<string, unknown>) {
          builder._op = 'update'
          builder._updatePayload = payload
          return builder
        },
        eq(col: keyof FakeRow, val: any) {
          builder._filters.push({ col, val })
          return builder
        },
        is(col: keyof FakeRow, val: any) {
          builder._isFilters.push({ col, val })
          return builder
        },
        async maybeSingle() {
          const found = rows.find((r) => builder._filters.every((f: any) => r[f.col as keyof FakeRow] === f.val))
          return { data: found ?? null, error: null }
        },
        async single() {
          if (builder._op === 'insert') {
            const id = `survey-${nextId++}`
            const row: FakeRow = {
              id,
              conversation_id: builder._insertPayload.conversation_id,
              account_id: builder._insertPayload.account_id,
              agent_user_id: builder._insertPayload.agent_user_id ?? null,
              customer_email: builder._insertPayload.customer_email ?? null,
              token: builder._insertPayload.token,
              responded_at: null,
              rating: null,
              feedback: null,
              sent_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
            }
            rows.push(row)
            return { data: { id }, error: null }
          }
          return { data: null, error: { message: 'not implemented' } }
        },
        // The "thenable" fallback for `await update().eq()` style.
        then(resolve: any) {
          if (builder._op === 'update') {
            const matches = rows.filter((r) => {
              if (!builder._filters.every((f: any) => r[f.col as keyof FakeRow] === f.val)) return false
              if (!builder._isFilters.every((f: any) => r[f.col as keyof FakeRow] === f.val)) return false
              return true
            })
            for (const m of matches) Object.assign(m, builder._updatePayload)
            resolve({
              data: builder._selectCols === '*' ? null : matches.map((r) => ({ id: r.id })),
              error: null,
            })
          } else if (builder._op === 'select') {
            const out = rows.filter((r) => builder._filters.every((f: any) => r[f.col as keyof FakeRow] === f.val))
            resolve({ data: out, error: null })
          } else {
            resolve({ data: null, error: null })
          }
        },
      }
      return builder
    },
  }
}

describe('createSurvey', () => {
  it('inserts a row and finalizes the token', async () => {
    const fake = makeFakeClient()
    const result = await createSurvey(fake as any, {
      conversationId: 'conv-1',
      accountId: 'acct-1',
      agentUserId: 'agent-1',
      customerEmail: 'c@x.example',
    })
    expect(result.id).toBe('survey-1')
    expect(result.token.startsWith('survey-1.')).toBe(true)
    expect(result.public_url.endsWith(`/csat/${encodeURIComponent(result.token)}`)).toBe(true)

    const row = fake.rows.find((r) => r.id === 'survey-1')
    expect(row?.token).toBe(result.token)
    expect(verifySurveyToken(row!.token)).toBe('survey-1')
  })
})

describe('recordResponse one-time semantics', () => {
  function seed(): ReturnType<typeof makeFakeClient> {
    return makeFakeClient([
      {
        id: 'survey-A',
        conversation_id: 'c1',
        account_id: 'a1',
        agent_user_id: 'u1',
        customer_email: null,
        token: 'survey-A.sig',
        responded_at: null,
        rating: null,
        feedback: null,
        sent_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400_000).toISOString(),
      },
    ])
  }

  it('400 on out-of-range rating', async () => {
    const fake = seed()
    expect(await recordResponse(fake as any, 'survey-A', 6)).toMatchObject({ ok: false, status: 400 })
    expect(await recordResponse(fake as any, 'survey-A', 0)).toMatchObject({ ok: false, status: 400 })
  })

  it('404 when survey id missing', async () => {
    const fake = seed()
    const r = await recordResponse(fake as any, 'nope', 5)
    expect(r).toMatchObject({ ok: false, status: 404 })
  })

  it('410 when expired', async () => {
    const fake = makeFakeClient([
      {
        id: 'survey-X',
        conversation_id: 'c1',
        account_id: 'a1',
        agent_user_id: null,
        customer_email: null,
        token: 'tok',
        responded_at: null,
        rating: null,
        feedback: null,
        sent_at: new Date().toISOString(),
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    ])
    const r = await recordResponse(fake as any, 'survey-X', 4)
    expect(r).toMatchObject({ ok: false, status: 410 })
  })

  it('records first response, rejects second with 409', async () => {
    const fake = seed()
    const r1 = await recordResponse(fake as any, 'survey-A', 5, 'great')
    expect(r1.ok).toBe(true)
    const updated = fake.rows.find((r) => r.id === 'survey-A')!
    expect(updated.rating).toBe(5)
    expect(updated.feedback).toBe('great')
    expect(updated.responded_at).toBeTruthy()

    const r2 = await recordResponse(fake as any, 'survey-A', 4, 'oops')
    expect(r2).toMatchObject({ ok: false, status: 409 })
    // Original rating unchanged
    expect(fake.rows.find((r) => r.id === 'survey-A')!.rating).toBe(5)
  })

  it('truncates oversize feedback to 4000 chars', async () => {
    const fake = seed()
    const big = 'x'.repeat(5000)
    await recordResponse(fake as any, 'survey-A', 3, big)
    const row = fake.rows.find((r) => r.id === 'survey-A')!
    expect(row.feedback?.length).toBe(4000)
  })
})

// ─── rollup() math ────────────────────────────────────────────────────

describe('rollup math', () => {
  it('returns zero aggregate for empty input', () => {
    const a = __test.rollup([])
    expect(a.avg_rating).toBe(0)
    expect(a.total_sent).toBe(0)
    expect(a.total_responded).toBe(0)
    expect(a.response_rate).toBe(0)
    expect(a.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
  })

  it('aggregates rating + response rate correctly', () => {
    const ts = new Date().toISOString()
    const a = __test.rollup([
      { rating: 5, responded_at: ts },
      { rating: 5, responded_at: ts },
      { rating: 3, responded_at: ts },
      { rating: 1, responded_at: ts },
      { rating: null, responded_at: null }, // sent but not responded
    ])
    expect(a.total_sent).toBe(5)
    expect(a.total_responded).toBe(4)
    expect(a.response_rate).toBeCloseTo(0.8)
    expect(a.avg_rating).toBeCloseTo((5 + 5 + 3 + 1) / 4)
    expect(a.distribution).toEqual({ 1: 1, 2: 0, 3: 1, 4: 0, 5: 2 })
  })

  it('ignores responses without a rating', () => {
    const ts = new Date().toISOString()
    const a = __test.rollup([
      { rating: null, responded_at: ts }, // odd shape, must still not count
    ])
    expect(a.total_responded).toBe(0)
    expect(a.avg_rating).toBe(0)
  })
})

// ─── companyCSATAggregate / agentCSATAggregate hit the right tables ───

describe('aggregate queries scope correctly', () => {
  function makeAggClient(opts: {
    accountIds: string[]
    rows: Array<{ rating: number | null; responded_at: string | null; account_id?: string; agent_user_id?: string }>
  }) {
    return {
      from(table: string) {
        const builder: any = {
          _table: table,
          _filters: [] as Array<{ col: string; val: any }>,
          _inFilter: null as { col: string; vals: any[] } | null,
          select() {
            return builder
          },
          eq(col: string, val: any) {
            builder._filters.push({ col, val })
            return builder
          },
          gte() {
            return builder
          },
          in(col: string, vals: any[]) {
            builder._inFilter = { col, vals }
            return builder
          },
          then(resolve: any) {
            if (builder._table === 'accounts') {
              return resolve({ data: opts.accountIds.map((id) => ({ id })), error: null })
            }
            if (builder._table === 'csat_surveys') {
              let rows = opts.rows
              if (builder._inFilter && builder._inFilter.col === 'account_id') {
                rows = rows.filter((r) => r.account_id && builder._inFilter.vals.includes(r.account_id))
              }
              for (const f of builder._filters) {
                rows = rows.filter((r: any) => r[f.col] === f.val)
              }
              return resolve({ data: rows, error: null })
            }
            return resolve({ data: null, error: null })
          },
        }
        return builder
      },
    }
  }

  it('companyCSATAggregate returns empty when company has no accounts', async () => {
    const client = makeAggClient({ accountIds: [], rows: [] })
    const a = await companyCSATAggregate(client as any, 'co-1')
    expect(a.total_sent).toBe(0)
  })

  it('companyCSATAggregate filters surveys to the company accounts', async () => {
    const ts = new Date().toISOString()
    const client = makeAggClient({
      accountIds: ['a1', 'a2'],
      rows: [
        { rating: 5, responded_at: ts, account_id: 'a1' },
        { rating: 4, responded_at: ts, account_id: 'a2' },
        { rating: 1, responded_at: ts, account_id: 'OTHER' }, // different company
      ],
    })
    const a = await companyCSATAggregate(client as any, 'co-1')
    expect(a.total_responded).toBe(2)
    expect(a.avg_rating).toBe(4.5)
  })

  it('agentCSATAggregate filters by agent_user_id', async () => {
    const ts = new Date().toISOString()
    const client = makeAggClient({
      accountIds: [],
      rows: [
        { rating: 4, responded_at: ts, agent_user_id: 'agent-1' },
        { rating: 2, responded_at: ts, agent_user_id: 'agent-1' },
        { rating: 5, responded_at: ts, agent_user_id: 'OTHER' },
      ],
    })
    const a = await agentCSATAggregate(client as any, 'agent-1')
    expect(a.total_responded).toBe(2)
    expect(a.avg_rating).toBe(3)
  })
})

// vi imported above is currently unused; kept import shape consistent
// with other suites in case spies are added later.
void vi
