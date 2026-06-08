// Tests for /api/conversations/[id]/merge[-preview|-candidates] and /unmerge
//
// Coverage:
//   * 401 on every verb when unauthenticated
//   * 400 when secondary_conversation_id missing or equal to primary
//   * 403 when verifyAccountAccess denies one of the two conversations
//   * 200 happy-path forwards to the RPC
//   * unmerge maps "no active merge" RPC errors to 400

import { describe, it, expect, beforeEach, vi } from 'vitest'

// merge / unmerge now gate on action:conversation.merge; grant it here.
vi.mock('@/lib/permissions/server', () => ({
  userIdCan: vi.fn(async () => true),
}))

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

interface AuthFixture {
  user: { id: string } | null
  /** account_ids the user can access; empty Set = nothing. */
  allowedAccounts: Set<string>
  /** Optional role override (default: 'supervisor'). Phase 2 destructive
   *  ops require isSupervisor() = supervisor / company_admin / super_admin.
   *  Set to 'company_member' to assert 403 on the role gate. */
  userRole?: string
}

const fixture = {
  auth: {
    user: { id: 'user-1' },
    allowedAccounts: new Set(['acc-a']),
  } as AuthFixture,
  // Convs by id
  convs: {
    primary: { id: 'primary', account_id: 'acc-a', merged_into_id: null },
    secondary: { id: 'secondary', account_id: 'acc-a', merged_into_id: null },
    other_company: { id: 'other_company', account_id: 'acc-z', merged_into_id: null },
  } as Record<string, { id: string; account_id: string; merged_into_id: string | null }>,
  rpcs: {
    merge_conversations: vi.fn(async (params: any) => ({
      data: {
        id: 'audit-1',
        primary_conversation_id: params.p_primary_id,
        secondary_conversation_id: params.p_secondary_id,
        message_ids: ['m1', 'm2'],
        merged_at: '2026-05-01T00:00:00Z',
      },
      error: null,
    })),
    unmerge_conversations: vi.fn(async (params: any) => ({
      data: {
        id: 'audit-1',
        primary_conversation_id: params.p_primary_id,
        secondary_conversation_id: params.p_secondary_id,
        message_ids: ['m1', 'm2'],
        merged_at: '2026-04-01T00:00:00Z',
        unmerged_at: '2026-05-01T00:00:00Z',
      },
      error: null,
    })),
  },
  /** Set true to make rate limiter deny all requests. */
  rateLimit: { allow: true },
}

function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: fixture.auth.user }, error: null }),
    },
  }
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      let mode: 'select' = 'select'
      void mode
      let filters: Array<{ kind: string; col: string; value: unknown }> = []
      let inFilter: { col: string; ids: string[] } | null = null
      const chain: any = {
        select: () => chain,
        eq: (col: string, value: unknown) => {
          filters.push({ kind: 'eq', col, value })
          return chain
        },
        in: (col: string, ids: string[]) => {
          inFilter = { col, ids }
          return chain
        },
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        insert: () => chain,
        update: () => chain,
        maybeSingle: async () => {
          if (table === 'conversations') {
            const eq = filters.find((f) => f.col === 'id')
            if (eq) {
              const c = fixture.convs[String(eq.value)]
              return { data: c ?? null, error: null }
            }
          }
          if (table === 'users') {
            const eq = filters.find((f) => f.col === 'id')
            if (eq && fixture.auth.user && eq.value === fixture.auth.user.id) {
              return {
                data: {
                  id: fixture.auth.user.id,
                  // Phase 2: merge/unmerge require supervisor+. Default to
                  // supervisor for happy paths; tests that need to assert
                  // the member→403 boundary override fixture.auth.userRole.
                  role: fixture.auth.userRole ?? 'supervisor',
                  account_id: 'acc-a',
                  company_id: 'comp-a',
                },
                error: null,
              }
            }
          }
          if (table === 'accounts') {
            const eq = filters.find((f) => f.col === 'id')
            if (eq) {
              // Return company_id matching the allowed-accounts set if the
              // account is allowed, otherwise a different one.
              if (fixture.auth.allowedAccounts.has(String(eq.value))) {
                return { data: { id: eq.value, company_id: 'comp-a' }, error: null }
              }
              return { data: { id: eq.value, company_id: 'comp-z' }, error: null }
            }
          }
          return { data: null, error: null }
        },
        then: async (resolve: (v: unknown) => unknown) => {
          if (table === 'conversations' && inFilter) {
            const ids = inFilter.ids
            const data = ids.map((i) => fixture.convs[i]).filter(Boolean)
            return resolve({ data, error: null })
          }
          if (table === 'audit_log') return resolve({ data: null, error: null })
          return resolve({ data: null, error: null })
        },
      }
      return chain
    },
    rpc: vi.fn(async (name: string, params: unknown) => {
      const fn = (fixture.rpcs as any)[name]
      if (fn) return await fn(params)
      return { data: null, error: null }
    }),
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

// Patch verifyAccountAccess + checkRateLimit so we don't need the real
// implementations (which would require a live DB).
vi.mock('@/lib/api-helpers', async () => {
  const actual = await vi.importActual<any>('@/lib/api-helpers')
  return {
    ...actual,
    verifyAccountAccess: vi.fn(async (_userId: string, accountId: string) =>
      fixture.auth.allowedAccounts.has(accountId)
    ),
    checkRateLimit: vi.fn(async () => fixture.rateLimit.allow),
  }
})

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<any>('@/lib/auth')
  return {
    ...actual,
    getAllowedAccountIds: vi.fn(async () => fixture.auth.allowedAccounts),
  }
})

// ---- Import routes AFTER mocks ------------------------------------

import { POST as previewPOST } from '@/app/api/conversations/[id]/merge-preview/route'
import { POST as mergePOST } from '@/app/api/conversations/[id]/merge/route'
import { POST as unmergePOST } from '@/app/api/conversations/[id]/unmerge/route'
import { GET as candidatesGET } from '@/app/api/conversations/[id]/merge-candidates/route'

beforeEach(() => {
  fixture.auth.user = { id: 'user-1' }
  fixture.auth.allowedAccounts = new Set(['acc-a'])
  fixture.rateLimit.allow = true
  fixture.rpcs.merge_conversations.mockClear()
  fixture.rpcs.unmerge_conversations.mockClear()
  // Reset conversation rows.
  fixture.convs.primary = { id: 'primary', account_id: 'acc-a', merged_into_id: null }
  fixture.convs.secondary = { id: 'secondary', account_id: 'acc-a', merged_into_id: null }
  fixture.convs.other_company = { id: 'other_company', account_id: 'acc-z', merged_into_id: null }
})

function jsonReq(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const mkParams = (id: string) => ({ params: Promise.resolve({ id }) })

// ─── /merge ────────────────────────────────────────────────────────

describe('POST /api/conversations/[id]/merge', () => {
  it('401 when unauthenticated', async () => {
    fixture.auth.user = null
    const res = await mergePOST(
      jsonReq('http://l/m', 'POST', { secondary_conversation_id: 'secondary' }),
      mkParams('primary')
    )
    expect(res.status).toBe(401)
  })

  it('400 when secondary id is missing', async () => {
    const res = await mergePOST(jsonReq('http://l/m', 'POST', {}), mkParams('primary'))
    expect(res.status).toBe(400)
  })

  it('400 when ids are equal', async () => {
    const res = await mergePOST(
      jsonReq('http://l/m', 'POST', { secondary_conversation_id: 'primary' }),
      mkParams('primary')
    )
    expect(res.status).toBe(400)
  })

  it('403 when secondary belongs to another account user cannot access', async () => {
    const res = await mergePOST(
      jsonReq('http://l/m', 'POST', { secondary_conversation_id: 'other_company' }),
      mkParams('primary')
    )
    expect(res.status).toBe(403)
  })

  it('200 happy path invokes the RPC', async () => {
    const res = await mergePOST(
      jsonReq('http://l/m', 'POST', { secondary_conversation_id: 'secondary' }),
      mkParams('primary')
    )
    expect(res.status).toBe(200)
    expect(fixture.rpcs.merge_conversations).toHaveBeenCalledTimes(1)
    const body = (await res.json()) as { merge: { audit_id: string } }
    expect(body.merge.audit_id).toBe('audit-1')
  })

  it('429 when rate-limited', async () => {
    fixture.rateLimit.allow = false
    const res = await mergePOST(
      jsonReq('http://l/m', 'POST', { secondary_conversation_id: 'secondary' }),
      mkParams('primary')
    )
    expect(res.status).toBe(429)
  })
})

// ─── /merge-preview ─────────────────────────────────────────────────

describe('POST /api/conversations/[id]/merge-preview', () => {
  it('401 unauthenticated', async () => {
    fixture.auth.user = null
    const res = await previewPOST(
      jsonReq('http://l/p', 'POST', { secondary_conversation_id: 'secondary' }),
      mkParams('primary')
    )
    expect(res.status).toBe(401)
  })

  it('400 when ids are equal', async () => {
    const res = await previewPOST(
      jsonReq('http://l/p', 'POST', { secondary_conversation_id: 'primary' }),
      mkParams('primary')
    )
    expect(res.status).toBe(400)
  })

  it('403 cross-account', async () => {
    const res = await previewPOST(
      jsonReq('http://l/p', 'POST', { secondary_conversation_id: 'other_company' }),
      mkParams('primary')
    )
    expect(res.status).toBe(403)
  })
})

// ─── /unmerge ─────────────────────────────────────────────────────

describe('POST /api/conversations/[id]/unmerge', () => {
  it('401 unauthenticated', async () => {
    fixture.auth.user = null
    const res = await unmergePOST(
      jsonReq('http://l/u', 'POST', { secondary_conversation_id: 'secondary' }),
      mkParams('primary')
    )
    expect(res.status).toBe(401)
  })

  it('200 happy path invokes the RPC', async () => {
    const res = await unmergePOST(
      jsonReq('http://l/u', 'POST', { secondary_conversation_id: 'secondary' }),
      mkParams('primary')
    )
    expect(res.status).toBe(200)
    expect(fixture.rpcs.unmerge_conversations).toHaveBeenCalledTimes(1)
  })

  it('400 when the RPC reports no active merge', async () => {
    fixture.rpcs.unmerge_conversations.mockImplementationOnce(
      (async () => ({
        data: null,
        error: { message: 'no active merge found between p and s' },
      })) as any
    )
    const res = await unmergePOST(
      jsonReq('http://l/u', 'POST', { secondary_conversation_id: 'secondary' }),
      mkParams('primary')
    )
    expect(res.status).toBe(400)
  })
})

// ─── /merge-candidates ─────────────────────────────────────────────

describe('GET /api/conversations/[id]/merge-candidates', () => {
  it('401 unauthenticated', async () => {
    fixture.auth.user = null
    const res = await candidatesGET(jsonReq('http://l/c', 'GET'), mkParams('primary'))
    expect(res.status).toBe(401)
  })

  it('404 when source conversation does not exist', async () => {
    const res = await candidatesGET(jsonReq('http://l/c', 'GET'), mkParams('does-not-exist'))
    expect(res.status).toBe(404)
  })
})
