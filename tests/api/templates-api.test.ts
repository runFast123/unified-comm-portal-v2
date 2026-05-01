// Tests for /api/templates and /api/templates/[id].
//
// Covers:
//   * 401 unauthenticated on every verb
//   * 403 when the caller has no profile / no company / wrong role
//   * GET scopes results to the caller's company (via service-role mock,
//     which mirrors what RLS enforces in production).
//   * POST validates body + creates with company_id pinned to the caller.
//   * PATCH / DELETE refuse cross-company access.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- Module mocks --------------------------------------------------

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

interface AuthFixture {
  user: { id: string } | null
  profile: { id: string; email: string; full_name: string | null; role: string; account_id: string | null; company_id: string | null } | null
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
  templates: [
    {
      id: 'tpl-a',
      company_id: 'comp-a',
      account_id: null,
      title: 'A welcome',
      subject: null,
      content: 'Hi {{customer.name}}',
      category: 'Support',
      shortcut: 'welcome',
      usage_count: 0,
      is_active: true,
      created_by: 'user-1',
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    },
    {
      id: 'tpl-b',
      company_id: 'comp-b',
      account_id: null,
      title: 'B welcome',
      subject: null,
      content: 'Other co welcome',
      category: 'Support',
      shortcut: 'welcome',
      usage_count: 0,
      is_active: true,
      created_by: 'user-2',
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    },
  ] as Record<string, unknown>[],
  inserts: [] as unknown[],
  updates: [] as Array<{ id: string; payload: Record<string, unknown> }>,
  deletes: [] as string[],
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
      const filters: Array<{ kind: string; col: string; value: unknown }> = []
      let mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
      let updatePayload: Record<string, unknown> | null = null
      let insertPayload: Record<string, unknown> | null = null
      let returnArray = true

      const exec = async () => {
        if (table === 'users') {
          // Only used by getCurrentUser inside auth.ts.
          return { data: fixture.auth.profile, error: null }
        }
        if (table !== 'reply_templates') {
          return { data: null, error: null }
        }
        if (mode === 'select') {
          let rows = fixture.templates
          for (const f of filters) {
            if (f.kind === 'eq') {
              rows = rows.filter((r) => r[f.col] === f.value)
            }
          }
          if (returnArray) {
            return { data: rows, error: null }
          }
          return { data: rows[0] ?? null, error: null }
        }
        if (mode === 'insert') {
          const row = {
            id: 'new-tpl',
            ...insertPayload,
            usage_count: 0,
            is_active: true,
            account_id: null,
            created_at: '2026-04-30T00:00:00Z',
            updated_at: '2026-04-30T00:00:00Z',
          }
          fixture.inserts.push(row)
          return { data: row, error: null }
        }
        if (mode === 'update') {
          const idEq = filters.find((f) => f.col === 'id')
          if (!idEq) return { data: null, error: null }
          fixture.updates.push({ id: String(idEq.value), payload: updatePayload || {} })
          const row = fixture.templates.find((r) => r.id === idEq.value)
          return { data: { ...row, ...(updatePayload || {}) }, error: null }
        }
        if (mode === 'delete') {
          const idEq = filters.find((f) => f.col === 'id')
          if (idEq) fixture.deletes.push(String(idEq.value))
          return { data: null, error: null }
        }
        return { data: null, error: null }
      }

      const chain: Record<string, unknown> = {
        select: () => {
          mode = mode === 'select' ? 'select' : mode
          return chain
        },
        insert: (payload: Record<string, unknown>) => {
          mode = 'insert'
          insertPayload = payload
          return chain
        },
        update: (payload: Record<string, unknown>) => {
          mode = 'update'
          updatePayload = payload
          return chain
        },
        delete: () => {
          mode = 'delete'
          return chain
        },
        eq: (col: string, value: unknown) => {
          filters.push({ kind: 'eq', col, value })
          return chain
        },
        order: () => chain,
        maybeSingle: async () => {
          returnArray = false
          return exec()
        },
        single: async () => {
          returnArray = false
          return exec()
        },
        // For await chain.then() style awaiting (used in PATCH/DELETE)
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          return exec().then(resolve, reject)
        },
      }
      return chain
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

// ---- Import routes AFTER mocks ------------------------------------

import { GET as listGET, POST as listPOST } from '@/app/api/templates/route'
import { GET as oneGET, PATCH as onePATCH, DELETE as oneDELETE } from '@/app/api/templates/[id]/route'

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
  fixture.inserts.length = 0
  fixture.updates.length = 0
  fixture.deletes.length = 0
})

function jsonReq(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('GET /api/templates', () => {
  it('401 when unauthenticated', async () => {
    fixture.auth.user = null
    const res = await listGET()
    expect(res.status).toBe(401)
  })

  it('returns only templates from the caller\'s company', async () => {
    const res = await listGET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { templates: Array<{ id: string; company_id: string }> }
    expect(body.templates.length).toBe(1)
    expect(body.templates[0].company_id).toBe('comp-a')
  })

  it('super_admin sees rows across all companies', async () => {
    fixture.auth.profile!.role = 'super_admin'
    fixture.auth.profile!.company_id = null
    const res = await listGET()
    const body = (await res.json()) as { templates: Array<{ id: string }> }
    expect(body.templates.length).toBe(2)
  })

  it('member without a company gets empty list', async () => {
    fixture.auth.profile!.role = 'company_member'
    fixture.auth.profile!.company_id = null
    const res = await listGET()
    const body = (await res.json()) as { templates: unknown[] }
    expect(body.templates).toEqual([])
  })
})

describe('POST /api/templates', () => {
  it('401 when unauthenticated', async () => {
    fixture.auth.user = null
    const res = await listPOST(jsonReq('http://l/templates', 'POST', { name: 'x', body: 'y' }))
    expect(res.status).toBe(401)
  })

  it('403 when caller is a plain member', async () => {
    fixture.auth.profile!.role = 'company_member'
    const res = await listPOST(jsonReq('http://l/templates', 'POST', { name: 'x', body: 'y' }))
    expect(res.status).toBe(403)
  })

  it('400 when name or body is missing', async () => {
    const r1 = await listPOST(jsonReq('http://l/templates', 'POST', { body: 'y' }))
    expect(r1.status).toBe(400)
    const r2 = await listPOST(jsonReq('http://l/templates', 'POST', { name: 'x' }))
    expect(r2.status).toBe(400)
  })

  it('creates a row pinned to the caller\'s company_id', async () => {
    const res = await listPOST(
      jsonReq('http://l/templates', 'POST', {
        name: '  My template  ',
        body: 'Hello {{customer.name}}',
        shortcut: '/Greet',
        category: 'Support',
        subject: '  Re: hi  ',
      })
    )
    expect(res.status).toBe(201)
    expect(fixture.inserts.length).toBe(1)
    const inserted = fixture.inserts[0] as Record<string, unknown>
    expect(inserted.company_id).toBe('comp-a')
    expect(inserted.title).toBe('My template')
    expect(inserted.shortcut).toBe('greet') // leading "/" stripped, lowercased
    expect(inserted.created_by).toBe('user-1')
    expect(inserted.subject).toBe('Re: hi')
  })
})

describe('PATCH /api/templates/[id]', () => {
  it('401 when unauthenticated', async () => {
    fixture.auth.user = null
    const res = await onePATCH(
      jsonReq('http://l/templates/tpl-a', 'PATCH', { name: 'x' }),
      { params: Promise.resolve({ id: 'tpl-a' }) }
    )
    expect(res.status).toBe(401)
  })

  it('403 when caller is a member', async () => {
    fixture.auth.profile!.role = 'company_member'
    const res = await onePATCH(
      jsonReq('http://l/templates/tpl-a', 'PATCH', { name: 'x' }),
      { params: Promise.resolve({ id: 'tpl-a' }) }
    )
    expect(res.status).toBe(403)
  })

  it('403 when company_admin patches a row from another company', async () => {
    const res = await onePATCH(
      jsonReq('http://l/templates/tpl-b', 'PATCH', { name: 'x' }),
      { params: Promise.resolve({ id: 'tpl-b' }) }
    )
    expect(res.status).toBe(403)
  })

  it('200 when company_admin patches their own row', async () => {
    const res = await onePATCH(
      jsonReq('http://l/templates/tpl-a', 'PATCH', { name: 'Renamed', is_active: false }),
      { params: Promise.resolve({ id: 'tpl-a' }) }
    )
    expect(res.status).toBe(200)
    expect(fixture.updates.length).toBe(1)
    expect(fixture.updates[0].id).toBe('tpl-a')
    expect(fixture.updates[0].payload.title).toBe('Renamed')
    expect(fixture.updates[0].payload.is_active).toBe(false)
  })

  it('super_admin can patch a row in another company', async () => {
    fixture.auth.profile!.role = 'super_admin'
    fixture.auth.profile!.company_id = null
    const res = await onePATCH(
      jsonReq('http://l/templates/tpl-b', 'PATCH', { name: 'x' }),
      { params: Promise.resolve({ id: 'tpl-b' }) }
    )
    expect(res.status).toBe(200)
  })
})

describe('DELETE /api/templates/[id]', () => {
  it('401 when unauthenticated', async () => {
    fixture.auth.user = null
    const res = await oneDELETE(jsonReq('http://l/templates/tpl-a', 'DELETE'), {
      params: Promise.resolve({ id: 'tpl-a' }),
    })
    expect(res.status).toBe(401)
  })

  it('403 cross-company', async () => {
    const res = await oneDELETE(jsonReq('http://l/templates/tpl-b', 'DELETE'), {
      params: Promise.resolve({ id: 'tpl-b' }),
    })
    expect(res.status).toBe(403)
  })

  it('200 happy path within own company', async () => {
    const res = await oneDELETE(jsonReq('http://l/templates/tpl-a', 'DELETE'), {
      params: Promise.resolve({ id: 'tpl-a' }),
    })
    expect(res.status).toBe(200)
    expect(fixture.deletes).toContain('tpl-a')
  })
})

describe('GET /api/templates/[id]', () => {
  it('returns template when in own company', async () => {
    const res = await oneGET(jsonReq('http://l/templates/tpl-a', 'GET'), {
      params: Promise.resolve({ id: 'tpl-a' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { template: { id: string } }
    expect(body.template.id).toBe('tpl-a')
  })

  it('403 cross-company even on read', async () => {
    const res = await oneGET(jsonReq('http://l/templates/tpl-b', 'GET'), {
      params: Promise.resolve({ id: 'tpl-b' }),
    })
    expect(res.status).toBe(403)
  })
})
