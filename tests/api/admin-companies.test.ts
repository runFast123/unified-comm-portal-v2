// Auth + behavior tests for the multi-tenancy admin API routes:
//
//   POST  /api/admin/companies                                       (super only)
//   PATCH /api/admin/companies/[id]                                  (super OR company_admin of id)
//   POST  /api/admin/companies/[id]/users/invite                     (super OR company_admin of id)
//   PATCH /api/admin/companies/[id]/users/[user_id]                  (super OR company_admin of id)
//   POST  /api/admin/companies/[id]/accounts/[account_id]/attach     (super OR company_admin of id; cross-tenant move = super)
//   POST  /api/admin/companies/[id]/accounts/[account_id]/detach     (super OR company_admin of id)
//
// We exercise the auth gate (anon → 401, member → 403, foreign company_admin → 403,
// own company_admin → 200, super → 200) plus a couple of happy-path validations.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

// ──────────────────────────────────────────────────────────────────────
// Test fixture: in-memory rows + a tiny fluent SQL stub.
// ──────────────────────────────────────────────────────────────────────

type UserRole =
  | 'super_admin'
  | 'admin'
  | 'company_admin'
  | 'company_member'
  | 'viewer'
  | 'reviewer'

interface UserFx {
  id: string
  email: string
  full_name: string | null
  role: UserRole
  company_id: string | null
  account_id: string | null
  is_active: boolean
}

interface AccountFx {
  id: string
  name: string
  channel_type: string
  is_active: boolean
  company_id: string | null
}

interface CompanyFx {
  id: string
  name: string
  slug: string | null
}

const fixture = {
  authUserId: null as string | null,
  users: new Map<string, UserFx>(),
  accounts: new Map<string, AccountFx>(),
  companies: new Map<string, CompanyFx>(),
  inserts: [] as Array<{ table: string; payload: unknown }>,
  updates: [] as Array<{ table: string; payload: unknown; filters: Array<[string, unknown]> }>,
}

const SUPER_ID = 'user-super'
const ADMIN_A_ID = 'user-admin-a'
const ADMIN_B_ID = 'user-admin-b'
const MEMBER_A_ID = 'user-member-a'
const COMP_A = 'comp-a'
const COMP_B = 'comp-b'
const ACCT_A1 = 'acct-a1'
const ACCT_A2 = 'acct-a2'
const ACCT_B1 = 'acct-b1'
const ACCT_DETACHED = 'acct-detached'

function reset() {
  fixture.authUserId = null
  fixture.users.clear()
  fixture.accounts.clear()
  fixture.companies.clear()
  fixture.inserts.length = 0
  fixture.updates.length = 0

  fixture.companies.set(COMP_A, { id: COMP_A, name: 'Acme', slug: 'acme' })
  fixture.companies.set(COMP_B, { id: COMP_B, name: 'Other Co', slug: 'other' })

  fixture.users.set(SUPER_ID, {
    id: SUPER_ID,
    email: 'super@x',
    full_name: 'Super',
    role: 'super_admin',
    company_id: null,
    account_id: null,
    is_active: true,
  })
  fixture.users.set(ADMIN_A_ID, {
    id: ADMIN_A_ID,
    email: 'admina@x',
    full_name: 'Admin A',
    role: 'company_admin',
    company_id: COMP_A,
    account_id: ACCT_A1,
    is_active: true,
  })
  // Second active admin in COMP_A so demoting/deactivating ADMIN_A doesn't trip
  // the "last admin" guard in tests that don't specifically target it.
  fixture.users.set('user-admin-a2', {
    id: 'user-admin-a2',
    email: 'admina2@x',
    full_name: 'Admin A2',
    role: 'company_admin',
    company_id: COMP_A,
    account_id: ACCT_A1,
    is_active: true,
  })
  fixture.users.set(ADMIN_B_ID, {
    id: ADMIN_B_ID,
    email: 'adminb@x',
    full_name: 'Admin B',
    role: 'company_admin',
    company_id: COMP_B,
    account_id: ACCT_B1,
    is_active: true,
  })
  fixture.users.set(MEMBER_A_ID, {
    id: MEMBER_A_ID,
    email: 'membera@x',
    full_name: 'Member A',
    role: 'company_member',
    company_id: COMP_A,
    account_id: ACCT_A1,
    is_active: true,
  })

  fixture.accounts.set(ACCT_A1, {
    id: ACCT_A1,
    name: 'Acme Teams',
    channel_type: 'teams',
    is_active: true,
    company_id: COMP_A,
  })
  fixture.accounts.set(ACCT_A2, {
    id: ACCT_A2,
    name: 'Acme Email',
    channel_type: 'email',
    is_active: true,
    company_id: COMP_A,
  })
  fixture.accounts.set(ACCT_B1, {
    id: ACCT_B1,
    name: 'Other Co Teams',
    channel_type: 'teams',
    is_active: true,
    company_id: COMP_B,
  })
  fixture.accounts.set(ACCT_DETACHED, {
    id: ACCT_DETACHED,
    name: 'Floating',
    channel_type: 'email',
    is_active: true,
    company_id: null,
  })
}

interface Filter {
  kind: 'eq' | 'in' | 'is'
  col: string
  value: unknown
}

function rowMatches(row: Record<string, unknown>, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.kind === 'eq') {
      if (row[f.col] !== f.value) return false
    } else if (f.kind === 'in') {
      if (!Array.isArray(f.value) || !(f.value as unknown[]).includes(row[f.col])) return false
    } else if (f.kind === 'is') {
      // is(col, null)
      if (f.value === null && row[f.col] !== null) return false
    }
  }
  return true
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      const filters: Filter[] = []
      let mode: 'select' | 'insert' | 'update' = 'select'
      let mutationPayload: Record<string, unknown> | null = null

      const chain: Record<string, unknown> = {}
      const self = chain as {
        select: (cols?: string, opts?: { count?: 'exact'; head?: boolean }) => typeof self
        eq: (col: string, value: unknown) => typeof self
        in: (col: string, value: unknown) => typeof self
        is: (col: string, value: unknown) => typeof self
        order: () => typeof self
        limit: () => typeof self
        gte: () => typeof self
        insert: (payload: Record<string, unknown>) => typeof self
        update: (payload: Record<string, unknown>) => typeof self
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>
        single: () => Promise<{ data: unknown; error: unknown }>
        then: (
          resolve: (v: { data: unknown; error: unknown; count?: number }) => unknown,
        ) => unknown
      }

      let countMode = false
      self.select = (_cols?: string, opts?: { count?: 'exact'; head?: boolean }) => {
        if (opts?.count === 'exact') countMode = true
        return self
      }
      self.eq = (col, value) => { filters.push({ kind: 'eq', col, value }); return self }
      self.in = (col, value) => { filters.push({ kind: 'in', col, value }); return self }
      self.is = (col, value) => { filters.push({ kind: 'is', col, value }); return self }
      self.order = () => self
      self.limit = () => self
      self.gte = () => self
      self.insert = (payload) => { mode = 'insert'; mutationPayload = payload; return self }
      self.update = (payload) => { mode = 'update'; mutationPayload = payload; return self }

      const tableMap: Record<string, Map<string, Record<string, unknown>>> = {
        users: fixture.users as unknown as Map<string, Record<string, unknown>>,
        accounts: fixture.accounts as unknown as Map<string, Record<string, unknown>>,
        companies: fixture.companies as unknown as Map<string, Record<string, unknown>>,
      }

      const terminal = async (): Promise<{
        data: unknown
        error: unknown
        count?: number
      }> => {
        const map = tableMap[table]
        if (mode === 'insert') {
          fixture.inserts.push({ table, payload: mutationPayload })
          if (table === 'companies') {
            const id = (mutationPayload?.id as string) ?? `comp-${fixture.companies.size + 1}`
            const row = { id, ...(mutationPayload as object) } as CompanyFx
            fixture.companies.set(id, row)
            return { data: row, error: null }
          }
          if (table === 'users') {
            const id = (mutationPayload?.id as string) ?? `user-${fixture.users.size + 1}`
            const row = { id, ...(mutationPayload as object) } as UserFx
            fixture.users.set(id, row)
            return { data: row, error: null }
          }
          // audit_log writes don't need to round-trip
          return { data: { id: 'audit-row' }, error: null }
        }

        if (mode === 'update' && map) {
          fixture.updates.push({
            table,
            payload: mutationPayload,
            filters: filters.map((f) => [f.col, f.value]),
          })
          let updated: Record<string, unknown> | null = null
          for (const row of Array.from(map.values())) {
            if (rowMatches(row, filters)) {
              Object.assign(row, mutationPayload)
              updated = row
              break
            }
          }
          return { data: updated, error: null }
        }

        // select path
        if (!map) return { data: null, error: null, count: 0 }
        const matches = Array.from(map.values()).filter((r) =>
          rowMatches(r, filters),
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
      self.then = (resolve) => Promise.resolve(terminal()).then(resolve)

      return self
    },
  }
}

function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({
        data: {
          user: fixture.authUserId ? { id: fixture.authUserId } : null,
        },
        error: null,
      }),
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

// ──────────────────────────────────────────────────────────────────────
// Imports — AFTER mocks
// ──────────────────────────────────────────────────────────────────────

import { POST as createCompany } from '@/app/api/admin/companies/route'
import { PATCH as updateCompany } from '@/app/api/admin/companies/[id]/route'
import { POST as inviteUser } from '@/app/api/admin/companies/[id]/users/invite/route'
import { PATCH as updateUser } from '@/app/api/admin/companies/[id]/users/[user_id]/route'
import { POST as attachAccount } from '@/app/api/admin/companies/[id]/accounts/[account_id]/attach/route'
import { POST as detachAccount } from '@/app/api/admin/companies/[id]/accounts/[account_id]/detach/route'

function jsonReq(url: string, body: unknown, method: string = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  reset()
})

// ──────────────────────────────────────────────────────────────────────
// POST /api/admin/companies
// ──────────────────────────────────────────────────────────────────────

describe('POST /api/admin/companies', () => {
  it('rejects anonymous → 401', async () => {
    fixture.authUserId = null
    const res = await createCompany(jsonReq('http://x/api/admin/companies', { name: 'X' }))
    expect(res.status).toBe(401)
  })

  it('rejects company_admin → 403 (super_admin only)', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await createCompany(jsonReq('http://x/api/admin/companies', { name: 'X' }))
    expect(res.status).toBe(403)
  })

  it('rejects company_member → 403', async () => {
    fixture.authUserId = MEMBER_A_ID
    const res = await createCompany(jsonReq('http://x/api/admin/companies', { name: 'X' }))
    expect(res.status).toBe(403)
  })

  it('super_admin creates company → 201', async () => {
    fixture.authUserId = SUPER_ID
    const res = await createCompany(
      jsonReq('http://x/api/admin/companies', { name: 'New Co', slug: 'new-co' }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { company: { name: string; slug: string } }
    expect(body.company.name).toBe('New Co')
    expect(body.company.slug).toBe('new-co')
  })

  it('rejects empty name → 400', async () => {
    fixture.authUserId = SUPER_ID
    const res = await createCompany(jsonReq('http://x/api/admin/companies', { name: '' }))
    expect(res.status).toBe(400)
  })

  it('rejects bad slug → 400', async () => {
    fixture.authUserId = SUPER_ID
    const res = await createCompany(
      jsonReq('http://x/api/admin/companies', { name: 'Y', slug: 'Bad Slug!' }),
    )
    expect(res.status).toBe(400)
  })
})

// ──────────────────────────────────────────────────────────────────────
// PATCH /api/admin/companies/[id]
// ──────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/companies/[id]', () => {
  const ctx = { params: Promise.resolve({ id: COMP_A }) }

  it('anon → 401', async () => {
    const res = await updateCompany(
      jsonReq(`http://x/api/admin/companies/${COMP_A}`, { name: 'Z' }, 'PATCH'),
      ctx,
    )
    expect(res.status).toBe(401)
  })

  it('foreign company_admin → 403', async () => {
    fixture.authUserId = ADMIN_B_ID
    const res = await updateCompany(
      jsonReq(`http://x/api/admin/companies/${COMP_A}`, { name: 'Z' }, 'PATCH'),
      ctx,
    )
    expect(res.status).toBe(403)
  })

  it('company_member of id → 403', async () => {
    fixture.authUserId = MEMBER_A_ID
    const res = await updateCompany(
      jsonReq(`http://x/api/admin/companies/${COMP_A}`, { name: 'Z' }, 'PATCH'),
      ctx,
    )
    expect(res.status).toBe(403)
  })

  it('own company_admin → 200', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await updateCompany(
      jsonReq(
        `http://x/api/admin/companies/${COMP_A}`,
        { name: 'Acme Renamed', accent_color: '#ff0000' },
        'PATCH',
      ),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(fixture.companies.get(COMP_A)?.name).toBe('Acme Renamed')
  })

  it('super_admin → 200 (cross-tenant)', async () => {
    fixture.authUserId = SUPER_ID
    const res = await updateCompany(
      jsonReq(`http://x/api/admin/companies/${COMP_A}`, { name: 'Acme XL' }, 'PATCH'),
      ctx,
    )
    expect(res.status).toBe(200)
  })

  it('rejects bad accent_color → 400', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await updateCompany(
      jsonReq(`http://x/api/admin/companies/${COMP_A}`, { accent_color: 'red' }, 'PATCH'),
      ctx,
    )
    expect(res.status).toBe(400)
  })

  it('rejects negative budget → 400', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await updateCompany(
      jsonReq(
        `http://x/api/admin/companies/${COMP_A}`,
        { monthly_ai_budget_usd: -50 },
        'PATCH',
      ),
      ctx,
    )
    expect(res.status).toBe(400)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Invite user
// ──────────────────────────────────────────────────────────────────────

describe('POST /api/admin/companies/[id]/users/invite', () => {
  const ctx = { params: Promise.resolve({ id: COMP_A }) }

  it('anon → 401', async () => {
    const res = await inviteUser(
      jsonReq(`http://x/api/admin/companies/${COMP_A}/users/invite`, {
        email: 'new@x',
      }),
      ctx,
    )
    expect(res.status).toBe(401)
  })

  it('foreign company_admin → 403', async () => {
    fixture.authUserId = ADMIN_B_ID
    const res = await inviteUser(
      jsonReq(`http://x/api/admin/companies/${COMP_A}/users/invite`, {
        email: 'new@x',
      }),
      ctx,
    )
    expect(res.status).toBe(403)
  })

  it('rejects bad email → 400', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await inviteUser(
      jsonReq(`http://x/api/admin/companies/${COMP_A}/users/invite`, {
        email: 'not-an-email',
      }),
      ctx,
    )
    expect(res.status).toBe(400)
  })

  it('own company_admin → 200 + user upserted with company_id', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await inviteUser(
      jsonReq(`http://x/api/admin/companies/${COMP_A}/users/invite`, {
        email: 'new@example.com',
        role: 'company_member',
        full_name: 'New User',
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    const created = Array.from(fixture.users.values()).find(
      (u) => u.email === 'new@example.com',
    )
    expect(created).toBeTruthy()
    expect(created?.company_id).toBe(COMP_A)
    expect(created?.role).toBe('company_member')
  })

  it('rejects account_id from a different company → 400', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await inviteUser(
      jsonReq(`http://x/api/admin/companies/${COMP_A}/users/invite`, {
        email: 'new@example.com',
        account_id: ACCT_B1,
      }),
      ctx,
    )
    expect(res.status).toBe(400)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Update user
// ──────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/companies/[id]/users/[user_id]', () => {
  const ctx = { params: Promise.resolve({ id: COMP_A, user_id: MEMBER_A_ID }) }

  it('anon → 401', async () => {
    const res = await updateUser(
      jsonReq(
        `http://x/api/admin/companies/${COMP_A}/users/${MEMBER_A_ID}`,
        { role: 'reviewer' },
        'PATCH',
      ),
      ctx,
    )
    expect(res.status).toBe(401)
  })

  it('foreign company_admin → 403', async () => {
    fixture.authUserId = ADMIN_B_ID
    const res = await updateUser(
      jsonReq(
        `http://x/api/admin/companies/${COMP_A}/users/${MEMBER_A_ID}`,
        { role: 'reviewer' },
        'PATCH',
      ),
      ctx,
    )
    expect(res.status).toBe(403)
  })

  it('own company_admin → 200', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await updateUser(
      jsonReq(
        `http://x/api/admin/companies/${COMP_A}/users/${MEMBER_A_ID}`,
        { role: 'reviewer' },
        'PATCH',
      ),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(fixture.users.get(MEMBER_A_ID)?.role).toBe('reviewer')
  })

  it('refuses to demote the last active company_admin → 400', async () => {
    fixture.authUserId = ADMIN_A_ID
    // Remove the second admin so only ADMIN_A_ID remains active.
    fixture.users.delete('user-admin-a2')
    const ownCtx = {
      params: Promise.resolve({ id: COMP_A, user_id: ADMIN_A_ID }),
    }
    const res = await updateUser(
      jsonReq(
        `http://x/api/admin/companies/${COMP_A}/users/${ADMIN_A_ID}`,
        { role: 'company_member' },
        'PATCH',
      ),
      ownCtx,
    )
    expect(res.status).toBe(400)
  })

  it('refuses to update a user from a different company → 404', async () => {
    fixture.authUserId = SUPER_ID
    const fakeCtx = {
      params: Promise.resolve({ id: COMP_A, user_id: ADMIN_B_ID }),
    }
    const res = await updateUser(
      jsonReq(
        `http://x/api/admin/companies/${COMP_A}/users/${ADMIN_B_ID}`,
        { role: 'company_member' },
        'PATCH',
      ),
      fakeCtx,
    )
    expect(res.status).toBe(404)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Attach / detach account
// ──────────────────────────────────────────────────────────────────────

describe('POST /api/admin/companies/[id]/accounts/[account_id]/attach', () => {
  it('anon → 401', async () => {
    const res = await attachAccount(
      new Request(
        `http://x/api/admin/companies/${COMP_A}/accounts/${ACCT_DETACHED}/attach`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: COMP_A, account_id: ACCT_DETACHED }) },
    )
    expect(res.status).toBe(401)
  })

  it('foreign company_admin → 403', async () => {
    fixture.authUserId = ADMIN_B_ID
    const res = await attachAccount(
      new Request(
        `http://x/api/admin/companies/${COMP_A}/accounts/${ACCT_DETACHED}/attach`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: COMP_A, account_id: ACCT_DETACHED }) },
    )
    expect(res.status).toBe(403)
  })

  it('own company_admin attaches a detached account → 200', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await attachAccount(
      new Request(
        `http://x/api/admin/companies/${COMP_A}/accounts/${ACCT_DETACHED}/attach`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: COMP_A, account_id: ACCT_DETACHED }) },
    )
    expect(res.status).toBe(200)
    expect(fixture.accounts.get(ACCT_DETACHED)?.company_id).toBe(COMP_A)
  })

  it('company_admin CANNOT cross-tenant move (account already in COMP_B) → 403', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await attachAccount(
      new Request(
        `http://x/api/admin/companies/${COMP_A}/accounts/${ACCT_B1}/attach`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: COMP_A, account_id: ACCT_B1 }) },
    )
    expect(res.status).toBe(403)
    expect(fixture.accounts.get(ACCT_B1)?.company_id).toBe(COMP_B)
  })

  it('super_admin can cross-tenant move → 200', async () => {
    fixture.authUserId = SUPER_ID
    const res = await attachAccount(
      new Request(
        `http://x/api/admin/companies/${COMP_A}/accounts/${ACCT_B1}/attach`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: COMP_A, account_id: ACCT_B1 }) },
    )
    expect(res.status).toBe(200)
    expect(fixture.accounts.get(ACCT_B1)?.company_id).toBe(COMP_A)
  })
})

describe('POST /api/admin/companies/[id]/accounts/[account_id]/detach', () => {
  it('anon → 401', async () => {
    const res = await detachAccount(
      new Request(
        `http://x/api/admin/companies/${COMP_A}/accounts/${ACCT_A1}/detach`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: COMP_A, account_id: ACCT_A1 }) },
    )
    expect(res.status).toBe(401)
  })

  it('foreign company_admin → 403', async () => {
    fixture.authUserId = ADMIN_B_ID
    const res = await detachAccount(
      new Request(
        `http://x/api/admin/companies/${COMP_A}/accounts/${ACCT_A1}/detach`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: COMP_A, account_id: ACCT_A1 }) },
    )
    expect(res.status).toBe(403)
  })

  it('own company_admin detaches → 200', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await detachAccount(
      new Request(
        `http://x/api/admin/companies/${COMP_A}/accounts/${ACCT_A1}/detach`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: COMP_A, account_id: ACCT_A1 }) },
    )
    expect(res.status).toBe(200)
    expect(fixture.accounts.get(ACCT_A1)?.company_id).toBeNull()
  })

  it('refuses to detach an account that does not belong to the company → 400', async () => {
    fixture.authUserId = SUPER_ID
    const res = await detachAccount(
      new Request(
        `http://x/api/admin/companies/${COMP_A}/accounts/${ACCT_B1}/detach`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: COMP_A, account_id: ACCT_B1 }) },
    )
    expect(res.status).toBe(400)
  })
})
