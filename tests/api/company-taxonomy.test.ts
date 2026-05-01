// Tests for /api/company-statuses and /api/company-tags route handlers.
//
// Coverage:
//   * 401 when unauthenticated
//   * 403 when a non-admin user attempts a write
//   * 200/201 happy path for admin create
//   * 400 on invalid payloads (color validation, missing name)
//   * super_admin can target a foreign company by passing company_id

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- Mocks ---------------------------------------------------------

const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  profile: { role: 'company_admin', company_id: 'co-a' } as
    | { role: string; company_id: string | null }
    | null,
  insertResult: null as Record<string, unknown> | null,
  insertError: null as { message: string; code?: string } | null,
  updateResult: null as Record<string, unknown> | null,
  existing: null as Record<string, unknown> | null,
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        ilike: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        insert: (payload: any) => {
          if (fixture.insertError) {
            return {
              select: () => ({
                single: async () => ({ data: null, error: fixture.insertError }),
              }),
            }
          }
          fixture.insertResult = { id: 'new-id', ...payload }
          return {
            select: () => ({
              single: async () => ({ data: fixture.insertResult, error: null }),
            }),
          }
        },
        update: (payload: any) => {
          fixture.updateResult = payload
          return {
            eq: () => ({
              select: () => ({
                single: async () => ({ data: { id: 'updated', ...payload }, error: null }),
              }),
              then: (resolve: any) => resolve({ data: null, error: null }),
            }),
          }
        },
        delete: () => ({
          eq: () => ({
            then: (resolve: any) => resolve({ data: null, error: null }),
          }),
        }),
        maybeSingle: async () => {
          if (table === 'users') {
            return { data: fixture.profile, error: null }
          }
          return { data: fixture.existing, error: null }
        },
        single: async () => ({ data: fixture.existing, error: null }),
        then: (resolve: any) => resolve({ data: [], error: null }),
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
vi.mock('@/lib/audit', () => ({
  logAudit: vi.fn(async () => undefined),
}))

// Import AFTER mocks
import { GET as GET_STATUSES, POST as POST_STATUS } from '@/app/api/company-statuses/route'
import { POST as POST_TAG } from '@/app/api/company-tags/route'

function jsonRequest(url: string, body: unknown, method: string = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/company-statuses', () => {
  beforeEach(() => {
    fixture.user = { id: 'user-1' }
    fixture.profile = { role: 'company_admin', company_id: 'co-a' }
  })

  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await GET_STATUSES(new Request('http://localhost/api/company-statuses'))
    expect(res.status).toBe(401)
  })

  it('returns an empty list when the user has no company scope', async () => {
    fixture.profile = { role: 'company_member', company_id: null }
    const res = await GET_STATUSES(new Request('http://localhost/api/company-statuses'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.statuses).toEqual([])
  })

  it('lists statuses for the caller company', async () => {
    fixture.profile = { role: 'company_member', company_id: 'co-a' }
    const res = await GET_STATUSES(new Request('http://localhost/api/company-statuses'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(Array.isArray(json.statuses)).toBe(true)
  })
})

describe('POST /api/company-statuses', () => {
  beforeEach(() => {
    fixture.user = { id: 'user-1' }
    fixture.profile = { role: 'company_admin', company_id: 'co-a' }
    fixture.insertResult = null
    fixture.insertError = null
  })

  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await POST_STATUS(
      jsonRequest('http://localhost/api/company-statuses', { name: 'x' }),
    )
    expect(res.status).toBe(401)
  })

  it('403 when caller is a member, not an admin', async () => {
    fixture.profile = { role: 'company_member', company_id: 'co-a' }
    const res = await POST_STATUS(
      jsonRequest('http://localhost/api/company-statuses', { name: 'x' }),
    )
    expect(res.status).toBe(403)
  })

  it('400 when name is missing', async () => {
    const res = await POST_STATUS(
      jsonRequest('http://localhost/api/company-statuses', { color: '#abc' }),
    )
    expect(res.status).toBe(400)
  })

  it('400 when color is invalid', async () => {
    const res = await POST_STATUS(
      jsonRequest('http://localhost/api/company-statuses', { name: 'x', color: 'rgb(0,0,0)' }),
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(String(json.error)).toMatch(/color/i)
  })

  it('201 happy path with default color', async () => {
    const res = await POST_STATUS(
      jsonRequest('http://localhost/api/company-statuses', { name: 'awaiting_legal' }),
    )
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.status?.name).toBe('awaiting_legal')
    expect(fixture.insertResult?.company_id).toBe('co-a')
  })

  it('409 when the unique constraint trips', async () => {
    fixture.insertError = { message: 'duplicate', code: '23505' }
    const res = await POST_STATUS(
      jsonRequest('http://localhost/api/company-statuses', { name: 'dup' }),
    )
    expect(res.status).toBe(409)
  })

  it('super_admin can specify a foreign company_id', async () => {
    fixture.profile = { role: 'super_admin', company_id: null }
    const res = await POST_STATUS(
      jsonRequest('http://localhost/api/company-statuses', {
        name: 'cross_tenant',
        company_id: 'co-b',
      }),
    )
    expect(res.status).toBe(201)
    expect(fixture.insertResult?.company_id).toBe('co-b')
  })

  it('400 when no company scope and not super_admin', async () => {
    fixture.profile = { role: 'company_admin', company_id: null }
    const res = await POST_STATUS(
      jsonRequest('http://localhost/api/company-statuses', { name: 'x' }),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/company-tags', () => {
  beforeEach(() => {
    fixture.user = { id: 'user-1' }
    fixture.profile = { role: 'company_admin', company_id: 'co-a' }
    fixture.insertResult = null
    fixture.insertError = null
  })

  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await POST_TAG(
      jsonRequest('http://localhost/api/company-tags', { name: 'vip' }),
    )
    expect(res.status).toBe(401)
  })

  it('403 when caller is a member, not an admin', async () => {
    fixture.profile = { role: 'company_member', company_id: 'co-a' }
    const res = await POST_TAG(
      jsonRequest('http://localhost/api/company-tags', { name: 'vip' }),
    )
    expect(res.status).toBe(403)
  })

  it('201 happy path', async () => {
    const res = await POST_TAG(
      jsonRequest('http://localhost/api/company-tags', { name: 'vip', color: '#ff00ff' }),
    )
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.tag?.name).toBe('vip')
    expect(fixture.insertResult?.created_by).toBe('user-1')
  })

  it('400 when color is invalid', async () => {
    const res = await POST_TAG(
      jsonRequest('http://localhost/api/company-tags', { name: 'vip', color: 'banana' }),
    )
    expect(res.status).toBe(400)
  })
})
