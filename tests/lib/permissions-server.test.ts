import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Coverage for the DB-backed permission resolver: it must split role rows into
 * platform vs company layers, apply per-user overrides last, and short-circuit
 * super_admin to all-access without a DB call.
 *
 * The service-role client is mocked as a chainable builder whose terminal await
 * resolves to the per-table rows we stage.
 */
const tables: Record<string, unknown[]> = { role_permissions: [], user_permissions: [] }

function builder(table: string) {
  const b: Record<string, unknown> = {}
  Object.assign(b, {
    select: () => b,
    eq: () => b,
    or: () => b,
    is: () => b,
    then: (resolve: (v: unknown) => void) => resolve({ data: tables[table] ?? [] }),
  })
  return b
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(async () => ({ from: (t: string) => builder(t) })),
}))

import { getEffectivePermissions } from '@/lib/permissions/server'

beforeEach(() => {
  tables.role_permissions = []
  tables.user_permissions = []
})

describe('getEffectivePermissions (DB-backed)', () => {
  it('super_admin is all-access (no DB rows needed)', async () => {
    const eff = await getEffectivePermissions({ id: 'u1', role: 'super_admin', company_id: 'c1' })
    expect(eff.has('section:admin.channels')).toBe(true)
    expect(eff.has('action:permissions.manage')).toBe(true)
  })

  it('applies a company role override on top of the baseline', async () => {
    // company_member baseline lacks admin.users; grant it for this company.
    tables.role_permissions = [
      { company_id: 'c1', permission_key: 'section:admin.users', allowed: true },
    ]
    const eff = await getEffectivePermissions({ id: 'u1', role: 'company_member', company_id: 'c1' })
    expect(eff.has('section:admin.users')).toBe(true)
  })

  it('per-user deny wins over a company grant', async () => {
    tables.role_permissions = [
      { company_id: 'c1', permission_key: 'channel:whatsapp', allowed: true },
    ]
    tables.user_permissions = [{ permission_key: 'channel:whatsapp', effect: 'deny' }]
    const eff = await getEffectivePermissions({ id: 'u1', role: 'company_member', company_id: 'c1' })
    expect(eff.has('channel:whatsapp')).toBe(false)
  })

  it('platform-default (null company) rows apply, and company rows override them', async () => {
    tables.role_permissions = [
      { company_id: null, permission_key: 'section:reports', allowed: false }, // platform denies
      { company_id: 'c1', permission_key: 'section:reports', allowed: true }, // company re-grants
    ]
    const eff = await getEffectivePermissions({ id: 'u1', role: 'company_member', company_id: 'c1' })
    expect(eff.has('section:reports')).toBe(true)
  })
})
