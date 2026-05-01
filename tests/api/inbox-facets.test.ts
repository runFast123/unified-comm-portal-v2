// Tests for GET /api/inbox/facets — the smart-inbox sidebar's count endpoint.
//
// Covers:
//   * 401 unauthenticated
//   * 403 when the caller has no profile
//   * Counts scoped to the caller's company via account whitelist
//   * Per-section "exclude self" math: applying ?category=X doesn't zero out
//     the categories section but DOES filter the sentiment section.
//   * super_admin sees all rows across companies (no scope).

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

interface AuthFixture {
  user: { id: string } | null
  profile: { id: string; email: string; full_name: string | null; role: string; account_id: string | null; company_id: string | null } | null
}

interface MessageRow {
  id: string
  channel: string
  account_id: string
  conversation_id: string
  direction: string
  is_spam: boolean
}

interface ClassRow {
  message_id: string
  category: string | null
  sentiment: string | null
  urgency: string | null
}

interface ConvRow {
  id: string
  status: string | null
  assigned_to: string | null
}

const fixture = {
  auth: {
    user: { id: 'user-1' },
    profile: {
      id: 'user-1',
      email: 'admin@a.example',
      full_name: 'Admin A',
      role: 'company_admin',
      account_id: null,
      company_id: 'comp-a',
    },
  } as AuthFixture,
  // Two companies; comp-a has 4 messages, comp-b has 2. Caller is company_admin@comp-a.
  accounts: [
    { id: 'acct-a1', company_id: 'comp-a' },
    { id: 'acct-a2', company_id: 'comp-a' },
    { id: 'acct-b1', company_id: 'comp-b' },
  ],
  messages: [
    // comp-a — Support / negative / high
    { id: 'm1', channel: 'email', account_id: 'acct-a1', conversation_id: 'c1', direction: 'inbound', is_spam: false },
    // comp-a — Support / neutral / medium
    { id: 'm2', channel: 'email', account_id: 'acct-a1', conversation_id: 'c2', direction: 'inbound', is_spam: false },
    // comp-a — Sales Inquiry / positive / low
    { id: 'm3', channel: 'teams', account_id: 'acct-a2', conversation_id: 'c3', direction: 'inbound', is_spam: false },
    // comp-a — Newsletter / neutral / low (assigned to user-1)
    { id: 'm4', channel: 'whatsapp', account_id: 'acct-a1', conversation_id: 'c4', direction: 'inbound', is_spam: false },
    // comp-b — should NEVER appear for comp-a admin
    { id: 'm5', channel: 'email', account_id: 'acct-b1', conversation_id: 'c5', direction: 'inbound', is_spam: false },
    { id: 'm6', channel: 'teams', account_id: 'acct-b1', conversation_id: 'c6', direction: 'inbound', is_spam: false },
  ] as MessageRow[],
  classifications: [
    { message_id: 'm1', category: 'Support', sentiment: 'negative', urgency: 'high' },
    { message_id: 'm2', category: 'Support', sentiment: 'neutral', urgency: 'medium' },
    { message_id: 'm3', category: 'Sales Inquiry', sentiment: 'positive', urgency: 'low' },
    { message_id: 'm4', category: 'Newsletter/Marketing', sentiment: 'neutral', urgency: 'low' },
    { message_id: 'm5', category: 'Support', sentiment: 'positive', urgency: 'high' },
    { message_id: 'm6', category: 'Sales Inquiry', sentiment: 'negative', urgency: 'urgent' },
  ] as ClassRow[],
  conversations: [
    { id: 'c1', status: 'active', assigned_to: null },
    { id: 'c2', status: 'in_progress', assigned_to: 'user-other' },
    { id: 'c3', status: 'active', assigned_to: null },
    { id: 'c4', status: 'resolved', assigned_to: 'user-1' },
    { id: 'c5', status: 'active', assigned_to: null },
    { id: 'c6', status: 'active', assigned_to: null },
  ] as ConvRow[],
}

function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: fixture.auth.user }, error: null }),
    },
  }
}

// Mock service-role client. Captures filters and returns the right slice
// of the in-memory fixtures. Supports the chains used by the route:
//   .from(table).select(cols).eq(col,val).maybeSingle()
//   .from(table).select(cols).eq(col,val).in(col, ids).limit(n)
//   .from(table).select(cols).in(col, ids)
function makeServiceClient() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from: (table: string): any => {
      const filters: Array<{ kind: string; col: string; value: unknown }> = []
      let returnArray = true

      const exec = async (): Promise<{ data: unknown; error: null }> => {
        if (table === 'users') {
          return { data: fixture.auth.profile, error: null }
        }
        if (table === 'accounts') {
          let rows = fixture.accounts
          for (const f of filters) {
            if (f.kind === 'eq') rows = rows.filter((r) => (r as Record<string, unknown>)[f.col] === f.value)
            if (f.kind === 'in') rows = rows.filter((r) => (f.value as unknown[]).includes((r as Record<string, unknown>)[f.col]))
          }
          return { data: returnArray ? rows : rows[0] ?? null, error: null }
        }
        if (table === 'messages') {
          let rows = fixture.messages
          for (const f of filters) {
            if (f.kind === 'eq') rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[f.col] === f.value)
            if (f.kind === 'in') rows = rows.filter((r) => (f.value as unknown[]).includes((r as unknown as Record<string, unknown>)[f.col]))
          }
          return { data: returnArray ? rows : rows[0] ?? null, error: null }
        }
        if (table === 'message_classifications') {
          let rows = fixture.classifications
          for (const f of filters) {
            if (f.kind === 'in') rows = rows.filter((r) => (f.value as unknown[]).includes((r as unknown as Record<string, unknown>)[f.col]))
          }
          return { data: rows, error: null }
        }
        if (table === 'conversations') {
          let rows = fixture.conversations
          for (const f of filters) {
            if (f.kind === 'in') rows = rows.filter((r) => (f.value as unknown[]).includes((r as unknown as Record<string, unknown>)[f.col]))
          }
          return { data: rows, error: null }
        }
        return { data: null, error: null }
      }

      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, value: unknown) => {
          filters.push({ kind: 'eq', col, value })
          return chain
        },
        in: (col: string, value: unknown) => {
          filters.push({ kind: 'in', col, value })
          return chain
        },
        limit: () => chain,
        maybeSingle: async () => {
          returnArray = false
          return exec()
        },
        then: (
          resolve: (v: unknown) => unknown,
          reject: (e: unknown) => unknown,
        ) => exec().then(resolve, reject),
      }
      return chain
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

import { GET } from '@/app/api/inbox/facets/route'

beforeEach(() => {
  fixture.auth.user = { id: 'user-1' }
  fixture.auth.profile = {
    id: 'user-1',
    email: 'admin@a.example',
    full_name: 'Admin A',
    role: 'company_admin',
    account_id: null,
    company_id: 'comp-a',
  }
})

function makeReq(qs = ''): Request {
  return new Request('http://l/api/inbox/facets' + (qs ? `?${qs}` : ''))
}

describe('GET /api/inbox/facets', () => {
  it('401 when unauthenticated', async () => {
    fixture.auth.user = null
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
  })

  it('403 when caller has no profile', async () => {
    fixture.auth.profile = null
    const res = await GET(makeReq())
    expect(res.status).toBe(403)
  })

  it('returns counts scoped to the caller\'s company', async () => {
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const body = (await res.json()) as Awaited<ReturnType<typeof GET>> extends Response ? Record<string, unknown> : never
    // 4 inbound non-spam messages in comp-a (m1-m4); m5/m6 are comp-b
    expect(body.total).toBe(4)
    // Channels — email=2 (m1,m2), teams=1 (m3), whatsapp=1 (m4)
    expect(body.channels).toEqual({ email: 2, teams: 1, whatsapp: 1 })
    // Sentiments
    expect(body.sentiments).toEqual({ positive: 1, neutral: 2, negative: 1 })
    // Urgencies
    expect(body.urgencies).toEqual({ low: 2, medium: 1, high: 1, urgent: 0 })
    // Statuses
    const statuses = body.statuses as Record<string, number>
    expect(statuses.active).toBe(2)
    expect(statuses.in_progress).toBe(1)
    expect(statuses.resolved).toBe(1)
    // Assignment — only c4 is assigned to user-1; c1,c3 are unassigned (c5,c6 belong to comp-b and are scoped out)
    expect(body.assigned_to_me).toBe(1)
    expect(body.unassigned).toBe(2)
    // Categories — sorted by count desc
    const cats = body.categories as Array<{ name: string; count: number }>
    expect(cats[0]).toEqual({ name: 'Support', count: 2 })
    expect(cats.find((c) => c.name === 'Sales Inquiry')?.count).toBe(1)
    expect(cats.find((c) => c.name === 'Newsletter/Marketing')?.count).toBe(1)
  })

  it('"exclude self" math: applying ?category=Support narrows OTHER sections but keeps the Categories chips non-zero', async () => {
    const res = await GET(makeReq('category=Support'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    // total reflects the active filter (only Support messages = m1, m2)
    expect(body.total).toBe(2)
    // Sentiments narrowed — m1=negative, m2=neutral
    expect(body.sentiments).toEqual({ positive: 0, neutral: 1, negative: 1 })
    // Categories section excludes its OWN filter, so it shows the full count
    const cats = body.categories as Array<{ name: string; count: number }>
    expect(cats.find((c) => c.name === 'Support')?.count).toBe(2)
    expect(cats.find((c) => c.name === 'Sales Inquiry')?.count).toBe(1)
    expect(cats.find((c) => c.name === 'Newsletter/Marketing')?.count).toBe(1)
  })

  it('?assignment=me narrows total but the assignment section keeps both chips visible', async () => {
    const res = await GET(makeReq('assignment=me'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    // Only c4 is assigned to user-1
    expect(body.total).toBe(1)
    // Assignment section excludes its own filter — both numbers from base
    expect(body.assigned_to_me).toBe(1)
    expect(body.unassigned).toBe(2)
  })

  it('super_admin sees all rows across companies', async () => {
    fixture.auth.profile = {
      id: 'user-1',
      email: 'sa@a.example',
      full_name: 'SA',
      role: 'super_admin',
      account_id: null,
      company_id: null,
    }
    const res = await GET(makeReq())
    const body = (await res.json()) as Record<string, unknown>
    // All 6 messages now visible
    expect(body.total).toBe(6)
  })

  it('untethered user (no company, no account) gets empty counts', async () => {
    fixture.auth.profile = {
      id: 'user-1',
      email: 'orphan@a.example',
      full_name: 'Orphan',
      role: 'company_member',
      account_id: null,
      company_id: null,
    }
    const res = await GET(makeReq())
    const body = (await res.json()) as Record<string, unknown>
    expect(body.total).toBe(0)
    expect(body.assigned_to_me).toBe(0)
    expect(body.unassigned).toBe(0)
  })
})
