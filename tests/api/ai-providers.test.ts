// Tests for the MULTI-PROVIDER AI configuration API (/api/ai-providers).
//
// Covers the security- and correctness-critical behaviors:
//   * GET masks api_key (has_api_key + api_key_masked, never the raw key).
//   * POST: the company's FIRST provider auto-activates.
//   * POST/PATCH: activating one provider deactivates the company's others
//     (honors the partial unique index — one active per company).
//   * Cross-company target (PATCH/DELETE on another company's row) → 403/404.
//   * PATCH without api_key (or with ''/null) preserves the stored key.
//
// Same harness as tests/api/security-fixes.test.ts: a tiny in-memory
// supabase-shaped fixture mocked in for @/lib/supabase-server, with routes
// imported AFTER the mocks. Auth/role resolution flows through the real
// tenant-guard against this fixture.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// The routes encrypt api_key at rest via src/lib/encryption (real module, not
// mocked) — give it a key ring. loadKeys() is lazy, so setting the env here
// (before any request runs) is sufficient.
process.env.CHANNEL_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')

// selected_company_id cookie is read by the GET handler for super_admin
// targeting; default to "no cookie set".
let cookieCompanyId: string | null = null
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (name: string) =>
      name === 'selected_company_id' && cookieCompanyId
        ? { value: cookieCompanyId }
        : undefined,
    getAll: () => [],
    set: () => {},
  }),
}))

// ──────────────────────────────────────────────────────────────────────
// Fixture
// ──────────────────────────────────────────────────────────────────────

interface UserFx {
  id: string
  role: string
  company_id: string | null
}
interface ProviderFx {
  id: string
  company_id: string
  name: string
  provider_key: string | null
  base_url: string
  api_key: string
  model: string
  max_tokens: number
  temperature: number
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

const SUPER_ID = 'user-super'
const ADMIN_A_ID = 'user-admin-a'
const ADMIN_B_ID = 'user-admin-b'
const MEMBER_A_ID = 'user-member-a'
const COMP_A = 'comp-a'
const COMP_B = 'comp-b'

const fixture = {
  authUserId: null as string | null,
  users: new Map<string, UserFx>(),
  ai_providers: new Map<string, ProviderFx>(),
  seq: 0,
}

function reset() {
  fixture.authUserId = null
  fixture.users.clear()
  fixture.ai_providers.clear()
  fixture.seq = 0
  cookieCompanyId = null

  fixture.users.set(SUPER_ID, { id: SUPER_ID, role: 'super_admin', company_id: null })
  fixture.users.set(ADMIN_A_ID, { id: ADMIN_A_ID, role: 'company_admin', company_id: COMP_A })
  fixture.users.set(ADMIN_B_ID, { id: ADMIN_B_ID, role: 'company_admin', company_id: COMP_B })
  fixture.users.set(MEMBER_A_ID, { id: MEMBER_A_ID, role: 'company_member', company_id: COMP_A })
}

function seedProvider(p: Partial<ProviderFx> & { id: string; company_id: string }): ProviderFx {
  const now = new Date().toISOString()
  const row: ProviderFx = {
    name: 'Seeded',
    provider_key: null,
    base_url: 'https://api.example/v1',
    api_key: 'sk-seeded-0000',
    model: 'gpt-x',
    max_tokens: 4096,
    temperature: 1,
    is_active: false,
    created_by: null,
    created_at: now,
    updated_at: now,
    ...p,
  }
  fixture.ai_providers.set(row.id, row)
  return row
}

// ──────────────────────────────────────────────────────────────────────
// Tiny supabase-shaped fluent builder (subset used by the routes + guard)
// ──────────────────────────────────────────────────────────────────────

interface Filter {
  kind: 'eq' | 'neq'
  col: string
  value: unknown
}

function rowMatches(row: Record<string, unknown>, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.kind === 'eq' && row[f.col] !== f.value) return false
    if (f.kind === 'neq' && row[f.col] === f.value) return false
  }
  return true
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      const filters: Filter[] = []
      let mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
      let mutationPayload: Record<string, unknown> | null = null
      let countMode = false

      const self: Record<string, any> = {}
      self.select = (_cols?: string, opts?: { count?: 'exact'; head?: boolean }) => {
        if (opts?.count === 'exact') countMode = true
        return self
      }
      self.eq = (col: string, value: unknown) => { filters.push({ kind: 'eq', col, value }); return self }
      self.neq = (col: string, value: unknown) => { filters.push({ kind: 'neq', col, value }); return self }
      self.order = () => self
      self.limit = () => self
      self.insert = (payload: any) => { mode = 'insert'; mutationPayload = payload; return self }
      self.update = (payload: any) => { mode = 'update'; mutationPayload = payload; return self }
      self.delete = () => { mode = 'delete'; return self }

      const tableMap: Record<string, Map<string, Record<string, unknown>>> = {
        users: fixture.users as unknown as Map<string, Record<string, unknown>>,
        ai_providers: fixture.ai_providers as unknown as Map<string, Record<string, unknown>>,
      }

      const terminal = async (): Promise<{ data: unknown; error: unknown; count?: number }> => {
        if (mode === 'insert') {
          if (table === 'ai_providers' && mutationPayload) {
            const now = new Date().toISOString()
            const row = {
              id: `prov-${++fixture.seq}`,
              max_tokens: 4096,
              temperature: 1,
              is_active: false,
              created_at: now,
              updated_at: now,
              ...(mutationPayload as object),
            } as ProviderFx
            fixture.ai_providers.set(row.id, row)
            return { data: row, error: null }
          }
          // audit_log + anything else — inert.
          return { data: { id: 'audit-row' }, error: null }
        }

        const map = tableMap[table]
        if (mode === 'update' && map) {
          let updated: Record<string, unknown> | null = null
          for (const row of Array.from(map.values())) {
            if (rowMatches(row, filters)) {
              Object.assign(row, mutationPayload)
              updated = row
              // update() may legitimately touch multiple rows (deactivate all).
            }
          }
          return { data: updated, error: null }
        }

        if (mode === 'delete' && map) {
          let deleted: Record<string, unknown> | null = null
          for (const [k, row] of Array.from(map.entries())) {
            if (rowMatches(row as Record<string, unknown>, filters)) {
              map.delete(k)
              deleted = row as Record<string, unknown>
            }
          }
          return { data: deleted, error: null }
        }

        // select
        if (!map) return { data: [], error: null, count: 0 }
        const matches = Array.from(map.values()).filter((r) =>
          rowMatches(r as Record<string, unknown>, filters),
        )
        if (countMode) return { data: null, error: null, count: matches.length }
        return { data: matches, error: null }
      }

      self.maybeSingle = async () => {
        const r = await terminal()
        const arr = (r.data as unknown[]) ?? []
        return { data: Array.isArray(arr) ? arr[0] ?? null : r.data, error: r.error }
      }
      self.single = async () => {
        const r = await terminal()
        const arr = (r.data as unknown[]) ?? []
        return { data: Array.isArray(arr) ? arr[0] ?? null : r.data, error: r.error }
      }
      self.then = (resolve: any) => Promise.resolve(terminal()).then(resolve)

      return self
    },
  }
}

function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: fixture.authUserId ? { id: fixture.authUserId } : null },
        error: null,
      }),
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }))

// ──────────────────────────────────────────────────────────────────────
// Imports — AFTER mocks
// ──────────────────────────────────────────────────────────────────────

import { GET as listGet, POST as createPost } from '@/app/api/ai-providers/route'
import { PATCH as providerPatch, DELETE as providerDelete } from '@/app/api/ai-providers/[id]/route'
import { decrypt } from '@/lib/encryption'

function jsonReq(url: string, body: unknown, method: string): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function activeRows(companyId: string): ProviderFx[] {
  return Array.from(fixture.ai_providers.values()).filter(
    (p) => p.company_id === companyId && p.is_active,
  )
}

beforeEach(() => reset())
afterEach(() => vi.clearAllMocks())

// ──────────────────────────────────────────────────────────────────────
// GET masks the api_key
// ──────────────────────────────────────────────────────────────────────

describe('GET /api/ai-providers masks keys', () => {
  it('returns has_api_key + api_key_masked and never the raw key', async () => {
    seedProvider({ id: 'p1', company_id: COMP_A, name: 'NVIDIA', api_key: 'nvapi-abcd1234', is_active: true })
    fixture.authUserId = ADMIN_A_ID

    const res = await listGet(new Request('http://x/api/ai-providers'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      providers: Array<Record<string, unknown>>
    }
    expect(body.providers).toHaveLength(1)
    const row = body.providers[0]
    expect(row.has_api_key).toBe(true)
    expect(row.api_key_masked).toBe('••••1234')
    // The raw key must never be serialized.
    expect('api_key' in row).toBe(false)
    expect(JSON.stringify(body)).not.toContain('nvapi-abcd1234')
  })

  it('only lists the caller company rows; a member can read (GET = requireUser)', async () => {
    seedProvider({ id: 'pa', company_id: COMP_A, api_key: 'sk-aaaa1111' })
    seedProvider({ id: 'pb', company_id: COMP_B, api_key: 'sk-bbbb2222' })
    fixture.authUserId = MEMBER_A_ID

    const res = await listGet(new Request('http://x/api/ai-providers'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { providers: Array<{ company_id: string }> }
    expect(body.providers.map((p) => p.company_id)).toEqual([COMP_A])
  })

  it('rejects unauthenticated callers → 401', async () => {
    fixture.authUserId = null
    const res = await listGet(new Request('http://x/api/ai-providers'))
    expect(res.status).toBe(401)
  })
})

// ──────────────────────────────────────────────────────────────────────
// POST first-provider auto-activates; activation is exclusive
// ──────────────────────────────────────────────────────────────────────

describe('POST /api/ai-providers activation rules', () => {
  it('the company FIRST provider auto-activates even without activate flag', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await createPost(
      jsonReq('http://x/api/ai-providers', {
        name: 'OpenAI',
        provider_key: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-first-9999',
        model: 'gpt-4o-mini',
      }, 'POST'),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { provider: { id: string; is_active: boolean; api_key_masked: string } }
    expect(body.provider.is_active).toBe(true)
    expect(body.provider.api_key_masked).toBe('••••9999')
    expect(activeRows(COMP_A)).toHaveLength(1)
  })

  it('a second provider stays inactive unless activate:true', async () => {
    seedProvider({ id: 'p1', company_id: COMP_A, is_active: true })
    fixture.authUserId = ADMIN_A_ID
    const res = await createPost(
      jsonReq('http://x/api/ai-providers', {
        name: 'Groq',
        base_url: 'https://api.groq.com/openai/v1',
        api_key: 'gsk_secondkey',
        model: 'llama-3.3-70b-versatile',
      }, 'POST'),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { provider: { is_active: boolean } }
    expect(body.provider.is_active).toBe(false)
    // Still exactly one active (the original p1).
    expect(activeRows(COMP_A).map((p) => p.id)).toEqual(['p1'])
  })

  it('activate:true deactivates the company other rows (exclusive active)', async () => {
    seedProvider({ id: 'p1', company_id: COMP_A, is_active: true })
    fixture.authUserId = ADMIN_A_ID
    const res = await createPost(
      jsonReq('http://x/api/ai-providers', {
        name: 'OpenRouter',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: 'sk-or-newactive',
        model: 'openai/gpt-4o-mini',
        activate: true,
      }, 'POST'),
    )
    expect(res.status).toBe(201)
    const active = activeRows(COMP_A)
    expect(active).toHaveLength(1)
    expect(active[0].name).toBe('OpenRouter')
    expect(fixture.ai_providers.get('p1')?.is_active).toBe(false)
  })

  it('rejects a non-member (company_member) write → 403', async () => {
    fixture.authUserId = MEMBER_A_ID
    const res = await createPost(
      jsonReq('http://x/api/ai-providers', {
        name: 'X', base_url: 'https://x/v1', api_key: 'k', model: 'm',
      }, 'POST'),
    )
    expect(res.status).toBe(403)
  })

  it('validates base_url / api_key / model non-empty → 400', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await createPost(
      jsonReq('http://x/api/ai-providers', {
        name: 'Bad', base_url: '', api_key: 'k', model: 'm',
      }, 'POST'),
    )
    expect(res.status).toBe(400)
  })

  it('stores the api_key ENCRYPTED at rest (v1: ciphertext), never plaintext', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await createPost(
      jsonReq('http://x/api/ai-providers', {
        name: 'OpenAI',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-plain-secret-1234',
        model: 'gpt-4o-mini',
      }, 'POST'),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { provider: { id: string; api_key_masked: string } }
    const stored = fixture.ai_providers.get(body.provider.id)?.api_key
    expect(stored).toBeDefined()
    expect(stored!.startsWith('v1:')).toBe(true)
    expect(stored).not.toContain('sk-plain-secret-1234')
    expect(decrypt(stored!)).toBe('sk-plain-secret-1234')
    // The mask reflects the PLAINTEXT tail, not the ciphertext's.
    expect(body.provider.api_key_masked).toBe('••••1234')
  })

  it('rejects an unknown provider_key → 400', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await createPost(
      jsonReq('http://x/api/ai-providers', {
        name: 'Bad', provider_key: 'not-a-real-provider',
        base_url: 'https://x/v1', api_key: 'k', model: 'm',
      }, 'POST'),
    )
    expect(res.status).toBe(400)
  })
})

// ──────────────────────────────────────────────────────────────────────
// PATCH — cross-company guard, key preservation, exclusive activation
// ──────────────────────────────────────────────────────────────────────

describe('PATCH /api/ai-providers/:id', () => {
  it('PATCH on another company row → 403, row untouched', async () => {
    seedProvider({ id: 'pb', company_id: COMP_B, name: 'B prov', api_key: 'sk-bbbb2222' })
    fixture.authUserId = ADMIN_A_ID
    const res = await providerPatch(
      jsonReq('http://x/api/ai-providers/pb', { name: 'pwned' }, 'PATCH'),
      { params: Promise.resolve({ id: 'pb' }) },
    )
    expect(res.status).toBe(403)
    expect(fixture.ai_providers.get('pb')?.name).toBe('B prov')
  })

  it('PATCH on a non-existent row → 404', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await providerPatch(
      jsonReq('http://x/api/ai-providers/missing', { name: 'x' }, 'PATCH'),
      { params: Promise.resolve({ id: 'missing' }) },
    )
    expect(res.status).toBe(404)
  })

  it('PATCH WITHOUT api_key preserves the stored key', async () => {
    seedProvider({ id: 'p1', company_id: COMP_A, name: 'Old', api_key: 'sk-keepme-7777' })
    fixture.authUserId = ADMIN_A_ID
    const res = await providerPatch(
      jsonReq('http://x/api/ai-providers/p1', { name: 'Renamed', model: 'gpt-new' }, 'PATCH'),
      { params: Promise.resolve({ id: 'p1' }) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { provider: { name: string; api_key_masked: string; has_api_key: boolean } }
    expect(body.provider.name).toBe('Renamed')
    expect(body.provider.has_api_key).toBe(true)
    expect(body.provider.api_key_masked).toBe('••••7777')
    // Stored key is unchanged.
    expect(fixture.ai_providers.get('p1')?.api_key).toBe('sk-keepme-7777')
  })

  it('PATCH with empty-string api_key does NOT wipe the stored key', async () => {
    seedProvider({ id: 'p1', company_id: COMP_A, api_key: 'sk-keepme-7777' })
    fixture.authUserId = ADMIN_A_ID
    const res = await providerPatch(
      jsonReq('http://x/api/ai-providers/p1', { api_key: '' }, 'PATCH'),
      { params: Promise.resolve({ id: 'p1' }) },
    )
    // Only api_key sent and it's empty → no real fields → 400 (nothing to update),
    // and crucially the stored key is preserved.
    expect(res.status).toBe(400)
    expect(fixture.ai_providers.get('p1')?.api_key).toBe('sk-keepme-7777')
  })

  it('PATCH with a NEW api_key rotates it (stored encrypted)', async () => {
    seedProvider({ id: 'p1', company_id: COMP_A, api_key: 'sk-old-0000' })
    fixture.authUserId = ADMIN_A_ID
    const res = await providerPatch(
      jsonReq('http://x/api/ai-providers/p1', { api_key: 'sk-rotated-5555' }, 'PATCH'),
      { params: Promise.resolve({ id: 'p1' }) },
    )
    expect(res.status).toBe(200)
    const stored = fixture.ai_providers.get('p1')?.api_key
    expect(stored?.startsWith('v1:')).toBe(true)
    expect(stored).not.toContain('sk-rotated-5555')
    expect(decrypt(stored!)).toBe('sk-rotated-5555')
    const body = (await res.json()) as { provider: { api_key_masked: string } }
    expect(body.provider.api_key_masked).toBe('••••5555')
  })

  it('PATCH is_active:true deactivates the company other rows', async () => {
    seedProvider({ id: 'p1', company_id: COMP_A, name: 'one', is_active: true })
    seedProvider({ id: 'p2', company_id: COMP_A, name: 'two', is_active: false })
    fixture.authUserId = ADMIN_A_ID
    const res = await providerPatch(
      jsonReq('http://x/api/ai-providers/p2', { is_active: true }, 'PATCH'),
      { params: Promise.resolve({ id: 'p2' }) },
    )
    expect(res.status).toBe(200)
    const active = activeRows(COMP_A)
    expect(active.map((p) => p.id)).toEqual(['p2'])
    expect(fixture.ai_providers.get('p1')?.is_active).toBe(false)
  })

  it('super_admin can PATCH a row in any company → 200', async () => {
    seedProvider({ id: 'pb', company_id: COMP_B, name: 'B prov' })
    fixture.authUserId = SUPER_ID
    const res = await providerPatch(
      jsonReq('http://x/api/ai-providers/pb', { name: 'edited by super' }, 'PATCH'),
      { params: Promise.resolve({ id: 'pb' }) },
    )
    expect(res.status).toBe(200)
    expect(fixture.ai_providers.get('pb')?.name).toBe('edited by super')
  })
})

// ──────────────────────────────────────────────────────────────────────
// DELETE — cross-company guard
// ──────────────────────────────────────────────────────────────────────

describe('DELETE /api/ai-providers/:id', () => {
  it('DELETE on another company row → 403, row survives', async () => {
    seedProvider({ id: 'pb', company_id: COMP_B })
    fixture.authUserId = ADMIN_A_ID
    const res = await providerDelete(
      new Request('http://x/api/ai-providers/pb', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'pb' }) },
    )
    expect(res.status).toBe(403)
    expect(fixture.ai_providers.has('pb')).toBe(true)
  })

  it('DELETE on own company row → 200, row gone', async () => {
    seedProvider({ id: 'pa', company_id: COMP_A })
    fixture.authUserId = ADMIN_A_ID
    const res = await providerDelete(
      new Request('http://x/api/ai-providers/pa', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'pa' }) },
    )
    expect(res.status).toBe(200)
    expect(fixture.ai_providers.has('pa')).toBe(false)
  })

  it('DELETE missing row → 404', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await providerDelete(
      new Request('http://x/api/ai-providers/nope', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'nope' }) },
    )
    expect(res.status).toBe(404)
  })
})
