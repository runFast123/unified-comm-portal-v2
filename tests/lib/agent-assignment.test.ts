// Integration tests for round-robin agent assignment, driven through the
// shared mock-supabase factory. These cover the two auto-assignment bugs that
// hit tenants using the modern role names:
//
//   Bug 1 — the candidate pool was filtered by `account_id`, but company
//   members have `company_id` set and `account_id = null`, so the pool came
//   back empty and pickNextAgent returned null.
//
//   Bug 2 — the team fallback queried `.eq('role','admin')`, which matches
//   nobody on a tenant whose admins are `company_admin`.

import { describe, it, expect, vi } from 'vitest'
import {
  createMockSupabase,
  type MockSupabase,
  type MockCall,
} from '../helpers/mock-supabase'

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(),
}))

import { createServiceRoleClient } from '@/lib/supabase-server'
import { pickNextAgent } from '@/lib/agent-assignment'

interface UserRow {
  id: string
  role: string
  is_active: boolean
  account_id: string | null
  company_id: string | null
}

interface BuildOpts {
  accounts?: Record<string, { company_id: string | null }>
  users?: UserRow[]
  loads?: Array<{ assigned_to: string }>
  pointer?: { last_assigned_user_id: string | null } | null
}

/** Apply the recorded Supabase filters to an in-memory users table. */
function applyUserFilters(users: UserRow[], filters: MockCall['filters']): UserRow[] {
  let out = users
  for (const f of filters ?? []) {
    if (f.kind === 'eq' && f.col === 'company_id') out = out.filter((u) => u.company_id === f.value)
    else if (f.kind === 'eq' && f.col === 'is_active') out = out.filter((u) => u.is_active === f.value)
    else if (f.kind === 'eq' && f.col === 'account_id') out = out.filter((u) => u.account_id === f.value)
    else if (f.kind === 'eq' && f.col === 'role') out = out.filter((u) => u.role === f.value)
    else if (f.kind === 'in' && f.col === 'account_id') out = out.filter((u) => (f.value as unknown[]).includes(u.account_id))
    else if (f.kind === 'in' && f.col === 'role') out = out.filter((u) => (f.value as unknown[]).includes(u.role))
  }
  return out
}

function buildMock(opts: BuildOpts): MockSupabase {
  const accounts = opts.accounts ?? {}
  const users = opts.users ?? []
  const loads = opts.loads ?? []
  const pointer = opts.pointer ?? null
  return createMockSupabase({
    handlers: {
      accounts: {
        onSelect: (filters) => {
          const idEq = filters?.find((f) => f.kind === 'eq' && f.col === 'id')
          const row = idEq ? accounts[idEq.value as string] : undefined
          return { data: row ?? null, error: null }
        },
      },
      users: {
        onSelect: (filters) => ({ data: applyUserFilters(users, filters), error: null }),
      },
      conversations: {
        onSelect: () => ({ data: loads, error: null }),
      },
      assignment_state: {
        onSelect: () => ({ data: pointer, error: null }),
      },
    },
  })
}

const COMP = 'comp-1'
const ACCT = 'acct-1'

describe('pickNextAgent — bug 1: candidate pool is company-scoped', () => {
  it('includes company-scoped agents (account_id = null) for an account-scoped pick', async () => {
    const users: UserRow[] = [
      { id: 'u-admin', role: 'company_admin', is_active: true, account_id: null, company_id: COMP },
      { id: 'u-member', role: 'company_member', is_active: true, account_id: null, company_id: COMP },
      { id: 'u-super', role: 'supervisor', is_active: true, account_id: null, company_id: COMP },
    ]
    const mock = buildMock({ accounts: { [ACCT]: { company_id: COMP } }, users })
    vi.mocked(createServiceRoleClient).mockResolvedValue(mock.client as never)

    const picked = await pickNextAgent({ account_id: ACCT })

    // Under the old `.in('account_id', …)` filter these account_id=null agents
    // never matched → empty pool → null. With the company_id fix, one is picked.
    expect(picked).not.toBeNull()
    expect(users.map((u) => u.id)).toContain(picked!)

    // Prove the candidate query was scoped by company_id, never account_id.
    const userSelects = mock.calls.filter((c) => c.table === 'users' && c.op === 'select')
    expect(userSelects.length).toBeGreaterThan(0)
    const usedCompanyId = userSelects.some((c) =>
      c.filters?.some((f) => f.kind === 'eq' && f.col === 'company_id' && f.value === COMP)
    )
    const usedAccountId = userSelects.some((c) =>
      c.filters?.some((f) => f.col === 'account_id')
    )
    expect(usedCompanyId).toBe(true)
    expect(usedAccountId).toBe(false)
  })

  it('falls back to account_id for a legacy account with no company', async () => {
    const users: UserRow[] = [
      { id: 'legacy-1', role: 'admin', is_active: true, account_id: ACCT, company_id: null },
    ]
    const mock = buildMock({ accounts: { [ACCT]: { company_id: null } }, users })
    vi.mocked(createServiceRoleClient).mockResolvedValue(mock.client as never)

    const picked = await pickNextAgent({ account_id: ACCT })
    expect(picked).toBe('legacy-1')
  })

  it('returns null when the company has no active agents', async () => {
    const users: UserRow[] = [
      { id: 'inactive', role: 'company_member', is_active: false, account_id: null, company_id: COMP },
    ]
    const mock = buildMock({ accounts: { [ACCT]: { company_id: COMP } }, users })
    vi.mocked(createServiceRoleClient).mockResolvedValue(mock.client as never)

    const picked = await pickNextAgent({ account_id: ACCT })
    expect(picked).toBeNull()
  })

  it('round-robins to the next agent after the last-assigned pointer', async () => {
    const users: UserRow[] = [
      { id: 'agent-a', role: 'company_member', is_active: true, account_id: null, company_id: COMP },
      { id: 'agent-b', role: 'company_member', is_active: true, account_id: null, company_id: COMP },
      { id: 'agent-c', role: 'company_member', is_active: true, account_id: null, company_id: COMP },
    ]
    const mock = buildMock({
      accounts: { [ACCT]: { company_id: COMP } },
      users,
      pointer: { last_assigned_user_id: 'agent-a' },
    })
    vi.mocked(createServiceRoleClient).mockResolvedValue(mock.client as never)

    // No loads → sorted alphabetically [a,b,c]; pointer at 'a' → next is 'b'.
    const picked = await pickNextAgent({ account_id: ACCT })
    expect(picked).toBe('agent-b')
  })
})

describe('pickNextAgent — bug 2: team fallback resolves modern admin roles', () => {
  it('picks a modern company_admin when a team has no other members', async () => {
    // Team scope carries no account_id (see routing-engine), so the pool is
    // built entirely from the admin fallback query. Under the old
    // `.eq('role','admin')` this matched nobody on a modern tenant.
    const users: UserRow[] = [
      { id: 'ca-1', role: 'company_admin', is_active: true, account_id: null, company_id: COMP },
    ]
    const mock = buildMock({ users })
    vi.mocked(createServiceRoleClient).mockResolvedValue(mock.client as never)

    const picked = await pickNextAgent({ team: 'support' })
    expect(picked).toBe('ca-1')

    // The fallback used `.in('role', …)` including the modern company_admin name.
    const roleSelect = mock.calls.find(
      (c) =>
        c.table === 'users' &&
        c.op === 'select' &&
        c.filters?.some((f) => f.kind === 'in' && f.col === 'role')
    )
    expect(roleSelect).toBeDefined()
    const roleFilter = roleSelect!.filters!.find((f) => f.kind === 'in' && f.col === 'role')
    expect(roleFilter!.value as string[]).toContain('company_admin')
  })
})
