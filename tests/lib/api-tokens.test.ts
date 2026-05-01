// Tests for src/lib/api-tokens.ts
//
// Coverage:
//   - generateToken returns a `ucp_<random>` plaintext, sha256 hash, and
//     8-char prefix; calls produce distinct values.
//   - hashToken is deterministic for the same input.
//   - parseBearerHeader extracts the token only from valid `Bearer <tok>`
//     headers; rejects garbage / missing / scheme-mismatch.
//   - requireScope throws ScopeRequiredError unless the scope is granted.
//   - verifyToken bumps last_used_at, returns null for revoked / expired /
//     unknown rows, and never returns plaintext.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Module mocks --------------------------------------------------

interface TokenFixture {
  id: string
  company_id: string
  scopes: string[]
  revoked_at: string | null
  expires_at: string | null
}

const fixture = {
  tokensByHash: new Map<string, TokenFixture>(),
  lastUsedAtUpdates: [] as Array<{ id: string; last_used_at: string }>,
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(async () => ({
    from: (table: string) => {
      // We only care about api_tokens here. Other tables: no-op.
      if (table !== 'api_tokens') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          update: () => ({ eq: async () => ({ data: null, error: null }) }),
        }
      }
      const filters: Array<{ col: string; value: unknown }> = []
      let mode: 'select' | 'update' = 'select'
      let updatePayload: Record<string, unknown> | null = null
      const chain: Record<string, unknown> = {
        select: () => {
          mode = 'select'
          return chain
        },
        update: (payload: Record<string, unknown>) => {
          mode = 'update'
          updatePayload = payload
          return chain
        },
        eq: (col: string, value: unknown) => {
          filters.push({ col, value })
          return chain
        },
        maybeSingle: async () => {
          const hashFilter = filters.find((f) => f.col === 'token_hash')
          if (!hashFilter) return { data: null, error: null }
          const row = fixture.tokensByHash.get(String(hashFilter.value))
          return { data: row ?? null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (mode === 'update') {
            const idFilter = filters.find((f) => f.col === 'id')
            if (idFilter && updatePayload?.last_used_at) {
              fixture.lastUsedAtUpdates.push({
                id: String(idFilter.value),
                last_used_at: String(updatePayload.last_used_at),
              })
            }
            return resolve({ data: null, error: null })
          }
          return resolve({ data: null, error: null })
        },
      }
      return chain
    },
  })),
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  })),
}))

// ---- Imports AFTER mocks -------------------------------------------

import {
  TOKEN_PREFIX,
  generateToken,
  hashToken,
  parseBearerHeader,
  requireScope,
  ScopeRequiredError,
  verifyToken,
} from '@/lib/api-tokens'

beforeEach(() => {
  fixture.tokensByHash.clear()
  fixture.lastUsedAtUpdates.length = 0
})

describe('generateToken', () => {
  it('returns a ucp_-prefixed plaintext, hex hash, and 8-char prefix', () => {
    const t = generateToken()
    expect(t.plaintext.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(t.plaintext.length).toBeGreaterThan(TOKEN_PREFIX.length + 8)
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(t.prefix.length).toBe(8)
    expect(t.prefix).toBe(t.plaintext.slice(0, 8))
  })

  it('produces distinct plaintext + hash across calls', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a.plaintext).not.toBe(b.plaintext)
    expect(a.hash).not.toBe(b.hash)
  })

  it('hashToken matches the hash returned by generateToken (no plaintext stored)', () => {
    const t = generateToken()
    expect(hashToken(t.plaintext)).toBe(t.hash)
  })
})

describe('parseBearerHeader', () => {
  it('extracts the token from a well-formed header', () => {
    expect(parseBearerHeader('Bearer ucp_abc123')).toBe('ucp_abc123')
    expect(parseBearerHeader('bearer ucp_abc123')).toBe('ucp_abc123') // case-insensitive
  })

  it('returns null for missing / malformed headers', () => {
    expect(parseBearerHeader(null)).toBeNull()
    expect(parseBearerHeader(undefined)).toBeNull()
    expect(parseBearerHeader('')).toBeNull()
    expect(parseBearerHeader('Token foo')).toBeNull()
    expect(parseBearerHeader('Bearer ')).toBeNull()
  })
})

describe('requireScope', () => {
  it('no-ops when scope is granted', () => {
    expect(() =>
      requireScope('messages:write', { token_id: 't', company_id: 'c', scopes: ['messages:write'] }),
    ).not.toThrow()
  })

  it('throws ScopeRequiredError when missing', () => {
    try {
      requireScope('messages:write', { token_id: 't', company_id: 'c', scopes: ['conversations:read'] })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeRequiredError)
      expect((err as ScopeRequiredError).scope).toBe('messages:write')
    }
  })
})

describe('verifyToken', () => {
  it('returns null for missing / malformed input', async () => {
    expect(await verifyToken('')).toBeNull()
    expect(await verifyToken('not-a-token')).toBeNull()
    expect(await verifyToken('ucp_short')).toBeNull()
  })

  it('returns null when the hash is not in the DB', async () => {
    const t = generateToken()
    expect(await verifyToken(t.plaintext)).toBeNull()
  })

  it('returns TokenInfo and bumps last_used_at on a fresh active token', async () => {
    const t = generateToken()
    fixture.tokensByHash.set(t.hash, {
      id: 'tok-1',
      company_id: 'comp-a',
      scopes: ['conversations:read'],
      revoked_at: null,
      expires_at: null,
    })
    const info = await verifyToken(t.plaintext)
    expect(info).toEqual({
      token_id: 'tok-1',
      company_id: 'comp-a',
      scopes: ['conversations:read'],
    })
    expect(fixture.lastUsedAtUpdates.length).toBe(1)
    expect(fixture.lastUsedAtUpdates[0].id).toBe('tok-1')
  })

  it('returns null when the token is revoked', async () => {
    const t = generateToken()
    fixture.tokensByHash.set(t.hash, {
      id: 'tok-2',
      company_id: 'comp-a',
      scopes: [],
      revoked_at: '2026-01-01T00:00:00Z',
      expires_at: null,
    })
    expect(await verifyToken(t.plaintext)).toBeNull()
  })

  it('returns null when the token has expired', async () => {
    const t = generateToken()
    fixture.tokensByHash.set(t.hash, {
      id: 'tok-3',
      company_id: 'comp-a',
      scopes: [],
      revoked_at: null,
      expires_at: '2020-01-01T00:00:00Z',
    })
    expect(await verifyToken(t.plaintext)).toBeNull()
  })

  it('accepts a token whose expiry is in the future', async () => {
    const t = generateToken()
    fixture.tokensByHash.set(t.hash, {
      id: 'tok-4',
      company_id: 'comp-a',
      scopes: ['messages:write'],
      revoked_at: null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    })
    const info = await verifyToken(t.plaintext)
    expect(info?.token_id).toBe('tok-4')
  })
})
