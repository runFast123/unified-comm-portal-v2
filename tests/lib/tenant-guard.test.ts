// Unit tests for the centralized tenant-scoping guard (src/lib/tenant-guard.ts).
//
// These run against the in-memory mock Supabase client (tests/helpers/
// mock-supabase.ts) — same style as tests/lib/multi-tenancy.test.ts. The guard
// authenticates via the *user* client's `auth.getUser()` (stubbed here through
// a mutable `currentAuthUserId`) and then loads role/company via the
// service-role client, so both supabase factories are mocked.
//
// What we cover (the contract that keeps service-role routes tenant-safe):
//   - no session            → requireUser 401 'Unauthorized'
//   - company_member        → requireCompanyAdmin 403 'Admin only'
//   - company_admin         → requireCompanyAdmin ok + correct ctx
//   - super_admin           → ctx.isSuperAdmin true, companyId null
//   - assertAccountAccess   → allow (same company / super_admin) vs deny (other company)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockSupabase, type MockSupabase } from '../helpers/mock-supabase'

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}))
// api-helpers (pulled in transitively by the guard via verifyAccountAccess)
// imports the DB-backed rate limiter; stub it so nothing touches the network.
vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}))

import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import {
  requireUser,
  requireCompanyAdmin,
  requireSupervisor,
  assertAccountAccess,
  tenantAccountIds,
  type TenantContext,
} from '@/lib/tenant-guard'

// ── Fixture ids ─────────────────────────────────────────────────────
const COMP_A = '00000000-0000-0000-0000-0000000000aa'
const COMP_B = '00000000-0000-0000-0000-0000000000bb'
const ACCT_A1 = '00000000-0000-0000-0000-00000000a001'
const ACCT_A2 = '00000000-0000-0000-0000-00000000a002'
const ACCT_B1 = '00000000-0000-0000-0000-00000000b001'
const USER_SUPER = '00000000-0000-0000-0000-0000000000ff'
const USER_ADMIN_A = '00000000-0000-0000-0000-0000000000a1'
const USER_MEMBER_A = '00000000-0000-0000-0000-0000000000a2'
const USER_SUPERVISOR_A = '00000000-0000-0000-0000-0000000000a3'
const USER_ADMIN_B = '00000000-0000-0000-0000-0000000000b1'

const usersById: Record<string, Record<string, unknown>> = {
  [USER_SUPER]: {
    id: USER_SUPER, email: 'super@x', full_name: 'Super',
    role: 'super_admin', account_id: null, company_id: null,
  },
  [USER_ADMIN_A]: {
    id: USER_ADMIN_A, email: 'a@x', full_name: 'A Admin',
    role: 'company_admin', account_id: ACCT_A1, company_id: COMP_A,
  },
  [USER_MEMBER_A]: {
    id: USER_MEMBER_A, email: 'm-a@x', full_name: 'A Member',
    role: 'company_member', account_id: ACCT_A1, company_id: COMP_A,
  },
  [USER_SUPERVISOR_A]: {
    id: USER_SUPERVISOR_A, email: 's-a@x', full_name: 'A Supervisor',
    role: 'supervisor', account_id: ACCT_A1, company_id: COMP_A,
  },
  [USER_ADMIN_B]: {
    id: USER_ADMIN_B, email: 'b@x', full_name: 'B Admin',
    role: 'company_admin', account_id: ACCT_B1, company_id: COMP_B,
  },
}

const accountsById: Record<string, Record<string, unknown>> = {
  [ACCT_A1]: { id: ACCT_A1, name: 'Acme Email', company_id: COMP_A },
  [ACCT_A2]: { id: ACCT_A2, name: 'Acme WhatsApp', company_id: COMP_A },
  [ACCT_B1]: { id: ACCT_B1, name: 'Other Co', company_id: COMP_B },
}

// Mutable session subject — set per-test to drive the user client's
// `auth.getUser()`. null means "no active session".
let currentAuthUserId: string | null = null

/**
 * Service-role client mock. Resolves `users` lookups by id and `accounts`
 * lookups by id or company_id (the latter returns an array, which the
 * getAllowedAccountIds helper iterates). Mirrors multi-tenancy.test.ts.
 */
function buildServiceMock(): MockSupabase {
  return createMockSupabase({
    handlers: {
      users: {
        onSelect: (filters) => {
          const eq = filters?.find((f) => f.kind === 'eq' && f.col === 'id')
          return { data: usersById[eq?.value as string] ?? null, error: null }
        },
      },
      accounts: {
        onSelect: (filters) => {
          const idEq = filters?.find((f) => f.kind === 'eq' && f.col === 'id')
          const compEq = filters?.find((f) => f.kind === 'eq' && f.col === 'company_id')
          if (idEq) {
            return { data: accountsById[idEq.value as string] ?? null, error: null }
          }
          if (compEq) {
            const rows = Object.values(accountsById).filter(
              (a) => a.company_id === compEq.value
            )
            return { data: rows, error: null } as unknown as { data: unknown; error: unknown }
          }
          return { data: null, error: null }
        },
      },
    },
  })
}

/** User-client mock — only the `auth.getUser()` surface the guard touches. */
function buildServerClient() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: currentAuthUserId ? { id: currentAuthUserId } : null },
        error: null,
      }),
    },
  }
}

beforeEach(() => {
  currentAuthUserId = null
  vi.mocked(createServerSupabaseClient).mockResolvedValue(
    buildServerClient() as never
  )
  vi.mocked(createServiceRoleClient).mockResolvedValue(
    buildServiceMock().client as never
  )
})

// ── requireUser ─────────────────────────────────────────────────────
describe('requireUser', () => {
  it('returns 401 Unauthorized when there is no session', async () => {
    currentAuthUserId = null
    const res = await requireUser()
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.status).toBe(401)
    expect(res.error).toBe('Unauthorized')
  })

  it('returns 401 when the session has no public.users row', async () => {
    // Authenticated at the auth layer but no tenancy row to scope against.
    currentAuthUserId = 'user-without-profile'
    const res = await requireUser()
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.status).toBe(401)
  })

  it('returns ok with a fully-populated ctx for a company_member', async () => {
    currentAuthUserId = USER_MEMBER_A
    const res = await requireUser()
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    const ctx: TenantContext = res.ctx
    expect(ctx.userId).toBe(USER_MEMBER_A)
    expect(ctx.role).toBe('company_member')
    expect(ctx.companyId).toBe(COMP_A)
    expect(ctx.isSuperAdmin).toBe(false)
  })

  it('flags super_admin and leaves companyId null', async () => {
    currentAuthUserId = USER_SUPER
    const res = await requireUser()
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.ctx.isSuperAdmin).toBe(true)
    expect(res.ctx.role).toBe('super_admin')
    expect(res.ctx.companyId).toBeNull()
  })
})

// ── requireCompanyAdmin ─────────────────────────────────────────────
describe('requireCompanyAdmin', () => {
  it('401 when unauthenticated', async () => {
    currentAuthUserId = null
    const res = await requireCompanyAdmin()
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.status).toBe(401)
  })

  it('403 Admin only for a company_member', async () => {
    currentAuthUserId = USER_MEMBER_A
    const res = await requireCompanyAdmin()
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.status).toBe(403)
    expect(res.error).toBe('Admin only')
  })

  it('403 Admin only for a supervisor (below company-admin)', async () => {
    currentAuthUserId = USER_SUPERVISOR_A
    const res = await requireCompanyAdmin()
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.status).toBe(403)
  })

  it('ok with correct ctx for a company_admin', async () => {
    currentAuthUserId = USER_ADMIN_A
    const res = await requireCompanyAdmin()
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.ctx.userId).toBe(USER_ADMIN_A)
    expect(res.ctx.role).toBe('company_admin')
    expect(res.ctx.companyId).toBe(COMP_A)
    expect(res.ctx.isSuperAdmin).toBe(false)
  })

  it('ok for super_admin (cross-tenant) with isSuperAdmin true', async () => {
    currentAuthUserId = USER_SUPER
    const res = await requireCompanyAdmin()
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.ctx.isSuperAdmin).toBe(true)
  })
})

// ── requireSupervisor ───────────────────────────────────────────────
describe('requireSupervisor', () => {
  it('403 for a company_member', async () => {
    currentAuthUserId = USER_MEMBER_A
    const res = await requireSupervisor()
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.status).toBe(403)
  })

  it('ok for a supervisor', async () => {
    currentAuthUserId = USER_SUPERVISOR_A
    const res = await requireSupervisor()
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.ctx.role).toBe('supervisor')
  })

  it('ok for a company_admin (above supervisor)', async () => {
    currentAuthUserId = USER_ADMIN_A
    const res = await requireSupervisor()
    expect(res.ok).toBe(true)
  })
})

// ── assertAccountAccess ─────────────────────────────────────────────
describe('assertAccountAccess', () => {
  async function ctxFor(userId: string): Promise<TenantContext> {
    currentAuthUserId = userId
    const res = await requireUser()
    if (!res.ok) throw new Error('expected an authenticated ctx')
    return res.ctx
  }

  it('allows a company_admin to reach a sibling account in the same company', async () => {
    const ctx = await ctxFor(USER_ADMIN_A)
    expect(await assertAccountAccess(ctx, ACCT_A2)).toBe(true)
  })

  it('denies a company_admin reaching an account in another company', async () => {
    const ctx = await ctxFor(USER_ADMIN_A)
    expect(await assertAccountAccess(ctx, ACCT_B1)).toBe(false)
  })

  it('allows super_admin to reach any account cross-tenant', async () => {
    const ctx = await ctxFor(USER_SUPER)
    expect(await assertAccountAccess(ctx, ACCT_A1)).toBe(true)
    expect(await assertAccountAccess(ctx, ACCT_B1)).toBe(true)
  })

  it('denies a B admin reaching an A account (other direction)', async () => {
    const ctx = await ctxFor(USER_ADMIN_B)
    expect(await assertAccountAccess(ctx, ACCT_A1)).toBe(false)
  })
})

// ── tenantAccountIds ────────────────────────────────────────────────
describe('tenantAccountIds', () => {
  async function ctxFor(userId: string): Promise<TenantContext> {
    currentAuthUserId = userId
    const res = await requireUser()
    if (!res.ok) throw new Error('expected an authenticated ctx')
    return res.ctx
  }

  it('returns null (all-access sentinel) for super_admin', async () => {
    const ctx = await ctxFor(USER_SUPER)
    expect(await tenantAccountIds(ctx)).toBeNull()
  })

  it('returns the company sibling accounts for a company user', async () => {
    const ctx = await ctxFor(USER_ADMIN_A)
    const ids = await tenantAccountIds(ctx)
    expect(ids).not.toBeNull()
    expect(ids!.has(ACCT_A1)).toBe(true)
    expect(ids!.has(ACCT_A2)).toBe(true)
    expect(ids!.has(ACCT_B1)).toBe(false)
  })
})
