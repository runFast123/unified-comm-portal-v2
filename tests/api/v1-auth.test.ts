// Tests for the public-facing /api/v1 routes' bearer-token gate.
//
// Coverage:
//   - 401 when no Authorization header is sent
//   - 401 when the bearer token is unknown / revoked
//   - 403 when the token is valid but missing the required scope
//   - 200 when the token is valid AND scope is granted, with results scoped
//     to tokenInfo.company_id (we should NOT see another company's row)

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

// ---- Fixture --------------------------------------------------------

interface ApiTokenRow {
  id: string
  company_id: string
  scopes: string[]
  revoked_at: string | null
  expires_at: string | null
}

const fixture = {
  // hash → row
  tokens: new Map<string, ApiTokenRow>(),
  accounts: [
    { id: 'acc-a', company_id: 'comp-a' },
    { id: 'acc-b', company_id: 'comp-b' },
  ],
  conversations: [
    { id: 'conv-a1', account_id: 'acc-a', channel: 'email', status: 'active', priority: 'medium', participant_name: null, participant_email: 'x@a.com', participant_phone: null, tags: [], first_message_at: null, last_message_at: '2026-04-30T10:00:00Z', created_at: '2026-04-30T09:00:00Z' },
    { id: 'conv-b1', account_id: 'acc-b', channel: 'email', status: 'active', priority: 'medium', participant_name: null, participant_email: 'y@b.com', participant_phone: null, tags: [], first_message_at: null, last_message_at: '2026-04-30T10:00:00Z', created_at: '2026-04-30T09:00:00Z' },
  ],
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  })),
  createServiceRoleClient: vi.fn(async () => ({
    from: (table: string) => {
      const filters: Array<{ kind: string; col: string; value: unknown }> = []
      let mode: 'select' | 'update' = 'select'
      let updatePayload: Record<string, unknown> | null = null

      const exec = async () => {
        if (table === 'api_tokens') {
          if (mode === 'select') {
            const hash = filters.find((f) => f.kind === 'eq' && f.col === 'token_hash')
            if (!hash) return { data: null, error: null }
            const row = fixture.tokens.get(String(hash.value))
            return { data: row ?? null, error: null }
          }
          // update last_used_at — no-op
          return { data: null, error: null }
        }
        if (table === 'accounts') {
          let rows = fixture.accounts as Array<Record<string, unknown>>
          for (const f of filters) {
            if (f.kind === 'eq') rows = rows.filter((r) => r[f.col] === f.value)
          }
          return { data: rows, error: null }
        }
        if (table === 'conversations') {
          let rows = fixture.conversations as Array<Record<string, unknown>>
          for (const f of filters) {
            if (f.kind === 'in') {
              const arr = f.value as unknown[]
              rows = rows.filter((r) => arr.includes(r[f.col] as never))
            } else if (f.kind === 'eq') {
              rows = rows.filter((r) => r[f.col] === f.value)
            }
          }
          return { data: rows, error: null, count: rows.length }
        }
        return { data: null, error: null }
      }

      const chain: Record<string, unknown> = {
        select: (_cols?: string, _opts?: unknown) => {
          mode = 'select'
          return chain
        },
        update: (payload: Record<string, unknown>) => {
          mode = 'update'
          updatePayload = payload
          return chain
        },
        eq: (col: string, value: unknown) => {
          filters.push({ kind: 'eq', col, value })
          return chain
        },
        in: (col: string, value: unknown[]) => {
          filters.push({ kind: 'in', col, value })
          return chain
        },
        order: () => chain,
        range: () => chain,
        maybeSingle: async () => exec(),
        single: async () => exec(),
        then: (resolve: (v: unknown) => unknown) => exec().then(resolve),
      }
      return chain
    },
  })),
}))

vi.mock('@/lib/logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

// ---- Imports AFTER mocks -------------------------------------------

import { hashToken, generateToken } from '@/lib/api-tokens'
import { GET as listConvs } from '@/app/api/v1/conversations/route'

beforeEach(() => {
  fixture.tokens.clear()
})

function reqWithAuth(url: string, auth?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = auth
  return new Request(url, { method: 'GET', headers })
}

describe('GET /api/v1/conversations — bearer auth', () => {
  it('401 when Authorization header is missing', async () => {
    const res = await listConvs(reqWithAuth('http://l/api/v1/conversations'))
    expect(res.status).toBe(401)
  })

  it('401 when the bearer token is unknown', async () => {
    const res = await listConvs(
      reqWithAuth('http://l/api/v1/conversations', 'Bearer ucp_unknown123456'),
    )
    expect(res.status).toBe(401)
  })

  it('401 when the token is revoked', async () => {
    const t = generateToken()
    fixture.tokens.set(hashToken(t.plaintext), {
      id: 'tok-1',
      company_id: 'comp-a',
      scopes: ['conversations:read'],
      revoked_at: '2026-01-01T00:00:00Z',
      expires_at: null,
    })
    const res = await listConvs(
      reqWithAuth('http://l/api/v1/conversations', `Bearer ${t.plaintext}`),
    )
    expect(res.status).toBe(401)
  })

  it('403 when the token lacks the conversations:read scope', async () => {
    const t = generateToken()
    fixture.tokens.set(hashToken(t.plaintext), {
      id: 'tok-2',
      company_id: 'comp-a',
      scopes: ['messages:write'],
      revoked_at: null,
      expires_at: null,
    })
    const res = await listConvs(
      reqWithAuth('http://l/api/v1/conversations', `Bearer ${t.plaintext}`),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('conversations:read')
  })

  it('200 with company-scoped conversations only', async () => {
    const t = generateToken()
    fixture.tokens.set(hashToken(t.plaintext), {
      id: 'tok-3',
      company_id: 'comp-a',
      scopes: ['conversations:read'],
      revoked_at: null,
      expires_at: null,
    })
    const res = await listConvs(
      reqWithAuth('http://l/api/v1/conversations', `Bearer ${t.plaintext}`),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { conversations: Array<{ id: string; account_id: string }> }
    // Should only see comp-a's conversation, not comp-b's.
    expect(body.conversations.length).toBe(1)
    expect(body.conversations[0].id).toBe('conv-a1')
    expect(body.conversations[0].account_id).toBe('acc-a')
  })
})
