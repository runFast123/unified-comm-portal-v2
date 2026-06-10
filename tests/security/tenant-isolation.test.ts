// Cross-tenant isolation regression guards.
//
// These lock in the service-role route fixes that close cross-tenant gaps:
// a company_admin of company A must NOT be able to touch company B's data via
// routes that use the service-role client (which bypasses RLS). The route is
// the only thing standing between a forged `account_id` / `id` and another
// tenant's data, so we assert the 403/empty-scope behaviour directly.
//
// Pattern mirrors tests/api/security-fixes.test.ts: an in-memory fixture +
// a tiny supabase-shaped fluent builder, wired through a mocked
// `@/lib/supabase-server`. The routes are imported AFTER the mocks so they
// pick up the stubs. Everything runs synchronously and never touches the
// network.
//
// Routes covered:
//   * /api/channels/config        GET / POST / DELETE  (verifyAccountAccess)
//   * /api/accounts               DELETE               (verifyAccountAccess)
//   * /api/sheets-sync            GET / POST           (getAllowedAccountIds + admin gate)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Gated endpoints (channels/config) now call userIdCan; grant it. This test is
// about TENANT isolation (verifyAccountAccess), not RBAC permissions.
vi.mock('@/lib/permissions/server', () => ({
  userIdCan: vi.fn(async () => true),
}))

// next/headers — channels/config + accounts read cookies()/headers() indirectly.
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}))

// ──────────────────────────────────────────────────────────────────────
// Fixture
// ──────────────────────────────────────────────────────────────────────

interface UserFx {
  id: string
  email: string
  full_name: string | null
  role: string
  account_id: string | null
  company_id: string | null
}
interface AccountFx {
  id: string
  name: string
  channel_type: string
  is_active: boolean
  company_id: string | null
}
interface SheetFx {
  id: string
  account_id: string | null
  sheet_id: string
  sheet_name: string
  sync_status: string
  column_mapping: Record<string, string> | null
  created_at: string
}

const SUPER_ID = 'user-super'
const ADMIN_A_ID = 'user-admin-a' // company A admin
const ADMIN_B_ID = 'user-admin-b' // company B admin
const MEMBER_A_ID = 'user-member-a' // company A non-admin
const COMP_A = 'comp-a'
const COMP_B = 'comp-b'
const ACCT_A1 = 'acct-a1'
const ACCT_B1 = 'acct-b1'
const SHEET_A1 = 'sheet-a1'
const SHEET_B1 = 'sheet-b1'

const fixture = {
  authUserId: null as string | null,
  users: new Map<string, UserFx>(),
  accounts: new Map<string, AccountFx>(),
  sheets: new Map<string, SheetFx>(),
  // Every insert/update/delete recorded so we can assert side-effects DID NOT
  // happen on a denied request (defense in depth — a 403 that still mutated
  // would be a silent failure).
  inserts: [] as Array<{ table: string; payload: unknown }>,
  updates: [] as Array<{ table: string; filters: Filter[]; payload: unknown }>,
  deletes: [] as Array<{ table: string; filters: Filter[] }>,
}

function reset() {
  fixture.authUserId = null
  fixture.users.clear()
  fixture.accounts.clear()
  fixture.sheets.clear()
  fixture.inserts.length = 0
  fixture.updates.length = 0
  fixture.deletes.length = 0

  fixture.users.set(SUPER_ID, {
    id: SUPER_ID, email: 'super@x', full_name: 'Super',
    role: 'super_admin', account_id: null, company_id: null,
  })
  fixture.users.set(ADMIN_A_ID, {
    id: ADMIN_A_ID, email: 'a@x', full_name: 'A Admin',
    role: 'company_admin', account_id: ACCT_A1, company_id: COMP_A,
  })
  fixture.users.set(ADMIN_B_ID, {
    id: ADMIN_B_ID, email: 'b@x', full_name: 'B Admin',
    role: 'company_admin', account_id: ACCT_B1, company_id: COMP_B,
  })
  fixture.users.set(MEMBER_A_ID, {
    id: MEMBER_A_ID, email: 'm-a@x', full_name: 'A Member',
    role: 'company_member', account_id: ACCT_A1, company_id: COMP_A,
  })

  fixture.accounts.set(ACCT_A1, {
    id: ACCT_A1, name: 'Acme Email', channel_type: 'email', is_active: true, company_id: COMP_A,
  })
  fixture.accounts.set(ACCT_B1, {
    id: ACCT_B1, name: 'B Email', channel_type: 'email', is_active: true, company_id: COMP_B,
  })

  fixture.sheets.set(SHEET_A1, {
    id: SHEET_A1, account_id: ACCT_A1, sheet_id: 'gsheet-a', sheet_name: 'Tab1',
    sync_status: 'active', column_mapping: null, created_at: '2026-05-01T00:00:00Z',
  })
  fixture.sheets.set(SHEET_B1, {
    id: SHEET_B1, account_id: ACCT_B1, sheet_id: 'gsheet-b', sheet_name: 'Tab1',
    sync_status: 'active', column_mapping: null, created_at: '2026-05-02T00:00:00Z',
  })
}

// ──────────────────────────────────────────────────────────────────────
// Tiny supabase-shaped fluent builder (subset our routes/helpers use)
// ──────────────────────────────────────────────────────────────────────

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
      const arr = f.value as unknown[]
      if (!Array.isArray(arr) || !arr.includes(row[f.col])) return false
    } else if (f.kind === 'is') {
      if (f.value === null && row[f.col] !== null) return false
    }
  }
  return true
}

const tableMap = (): Record<string, Map<string, Record<string, unknown>>> => ({
  users: fixture.users as unknown as Map<string, Record<string, unknown>>,
  accounts: fixture.accounts as unknown as Map<string, Record<string, unknown>>,
  google_sheets_sync: fixture.sheets as unknown as Map<string, Record<string, unknown>>,
})

function makeServiceClient() {
  return {
    from: (table: string) => {
      const filters: Filter[] = []
      let mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
      let mutationPayload: Record<string, unknown> | Array<Record<string, unknown>> | null = null

      const chain: Record<string, unknown> = {}
      const self = chain as Record<string, (...args: unknown[]) => unknown>

      self.select = () => self
      self.eq = (col: unknown, value: unknown) => { filters.push({ kind: 'eq', col: col as string, value }); return self }
      self.in = (col: unknown, value: unknown) => { filters.push({ kind: 'in', col: col as string, value }); return self }
      self.is = (col: unknown, value: unknown) => { filters.push({ kind: 'is', col: col as string, value }); return self }
      self.order = () => self
      self.limit = () => self
      self.gte = () => self
      self.insert = (payload: unknown) => { mode = 'insert'; mutationPayload = payload as Record<string, unknown>; return self }
      self.update = (payload: unknown) => { mode = 'update'; mutationPayload = payload as Record<string, unknown>; return self }
      self.upsert = (payload: unknown) => { mode = 'update'; mutationPayload = payload as Record<string, unknown>; return self }
      self.delete = () => { mode = 'delete'; return self }

      const terminal = async (): Promise<{ data: unknown; error: unknown }> => {
        const map = tableMap()[table]

        if (mode === 'insert') {
          fixture.inserts.push({ table, payload: mutationPayload })
          // audit_log etc. don't need to round-trip; echo a fake id.
          const row = Array.isArray(mutationPayload)
            ? mutationPayload
            : { id: `${table}-new`, ...(mutationPayload as object) }
          return { data: row, error: null }
        }
        if (mode === 'update') {
          fixture.updates.push({ table, filters: [...filters], payload: mutationPayload })
          if (map) {
            for (const row of Array.from(map.values())) {
              if (rowMatches(row, filters)) { Object.assign(row, mutationPayload); break }
            }
          }
          return { data: null, error: null }
        }
        if (mode === 'delete') {
          fixture.deletes.push({ table, filters: [...filters] })
          if (map) {
            for (const [k, row] of Array.from(map.entries())) {
              if (rowMatches(row as Record<string, unknown>, filters)) { map.delete(k); break }
            }
          }
          return { data: null, error: null }
        }

        // select
        if (!map) return { data: [], error: null }
        const matches = Array.from(map.values()).filter((r) =>
          rowMatches(r as Record<string, unknown>, filters),
        )
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
      // Awaited directly (select-list, update().eq(), delete().eq()) → resolve
      // the full terminal so callers that read `data` as an array work.
      self.then = ((resolve: (v: unknown) => unknown) =>
        Promise.resolve(terminal()).then(resolve)) as unknown as (...a: unknown[]) => unknown

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

// Neutralize the credential / OAuth / request-id helpers the routes import so
// no encryption, cookie, or crypto code runs. Each returns a benign value;
// none of the cross-tenant assertions below should ever reach them anyway
// (the 403 fires first), but the happy-path cases do.
vi.mock('@/lib/channel-config', () => ({
  getMaskedChannelConfig: vi.fn(async () => ({ source: 'none', config: null })),
  saveChannelConfig: vi.fn(async () => {}),
  deleteChannelConfig: vi.fn(async () => {}),
  getChannelConfig: vi.fn(async () => null),
  // Pass-through: with nothing stored there are no secrets to merge back in.
  mergeWithStoredSecrets: vi.fn(async (_accountId: string, _channel: string, c: Record<string, unknown>) => c),
  // Field-presence validation is exercised in channel-config-validation.test.ts;
  // here every posted config is complete, so treat all as valid.
  firstMissingConfigField: vi.fn(() => null),
}))
vi.mock('@/lib/integration-settings', () => ({
  getAzureOAuth: vi.fn(async () => null),
}))
vi.mock('@/lib/request-id', () => ({
  getRequestId: vi.fn(async () => 'req-test'),
}))

// ──────────────────────────────────────────────────────────────────────
// Imports — AFTER mocks
// ──────────────────────────────────────────────────────────────────────

import {
  GET as channelsGET,
  POST as channelsPOST,
  DELETE as channelsDELETE,
} from '@/app/api/channels/config/route'
import { DELETE as accountsDELETE } from '@/app/api/accounts/route'
import { GET as sheetsGET, POST as sheetsPOST } from '@/app/api/sheets-sync/route'

function jsonReq(url: string, body: unknown, method = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const EMAIL_CONFIG = { smtp_host: 'smtp.x', smtp_user: 'u', smtp_password: 'p' }

beforeEach(() => reset())
afterEach(() => vi.clearAllMocks())

// ──────────────────────────────────────────────────────────────────────
// /api/channels/config — GET / POST / DELETE (verifyAccountAccess gate)
// ──────────────────────────────────────────────────────────────────────

describe('/api/channels/config cross-tenant isolation', () => {
  describe('GET', () => {
    it('company_admin of A reading company B account → 403', async () => {
      fixture.authUserId = ADMIN_A_ID
      const res = await channelsGET(
        new Request(`http://x/api/channels/config?account_id=${ACCT_B1}&channel=email`),
      )
      expect(res.status).toBe(403)
    })

    it('company_admin of A reading own account → 200', async () => {
      fixture.authUserId = ADMIN_A_ID
      const res = await channelsGET(
        new Request(`http://x/api/channels/config?account_id=${ACCT_A1}&channel=email`),
      )
      expect(res.status).toBe(200)
    })

    it('super_admin reading any tenant account → 200', async () => {
      fixture.authUserId = SUPER_ID
      const res = await channelsGET(
        new Request(`http://x/api/channels/config?account_id=${ACCT_B1}&channel=email`),
      )
      expect(res.status).toBe(200)
    })

    it('unauthenticated → 401', async () => {
      fixture.authUserId = null
      const res = await channelsGET(
        new Request(`http://x/api/channels/config?account_id=${ACCT_A1}&channel=email`),
      )
      expect(res.status).toBe(401)
    })

    it('non-admin (company_member) → 403 (admin gate)', async () => {
      fixture.authUserId = MEMBER_A_ID
      const res = await channelsGET(
        new Request(`http://x/api/channels/config?account_id=${ACCT_A1}&channel=email`),
      )
      expect(res.status).toBe(403)
    })
  })

  describe('POST', () => {
    it('company_admin of A writing creds to company B account → 403 and no save', async () => {
      fixture.authUserId = ADMIN_A_ID
      const { saveChannelConfig } = await import('@/lib/channel-config')
      const res = await channelsPOST(
        jsonReq('http://x/api/channels/config', {
          account_id: ACCT_B1, channel: 'email', config: EMAIL_CONFIG,
        }),
      )
      expect(res.status).toBe(403)
      expect(saveChannelConfig).not.toHaveBeenCalled()
      // The audit_log insert must not fire on a denied write either.
      expect(fixture.inserts.some((i) => i.table === 'audit_log')).toBe(false)
    })

    it('company_admin of A writing creds to own account → 200', async () => {
      fixture.authUserId = ADMIN_A_ID
      const res = await channelsPOST(
        jsonReq('http://x/api/channels/config', {
          account_id: ACCT_A1, channel: 'email', config: EMAIL_CONFIG,
        }),
      )
      expect(res.status).toBe(200)
    })

    it('super_admin writing creds cross-tenant → 200', async () => {
      fixture.authUserId = SUPER_ID
      const res = await channelsPOST(
        jsonReq('http://x/api/channels/config', {
          account_id: ACCT_B1, channel: 'email', config: EMAIL_CONFIG,
        }),
      )
      expect(res.status).toBe(200)
    })
  })

  describe('DELETE', () => {
    it('company_admin of A deleting company B config → 403 and no delete', async () => {
      fixture.authUserId = ADMIN_A_ID
      const { deleteChannelConfig } = await import('@/lib/channel-config')
      const res = await channelsDELETE(
        new Request(`http://x/api/channels/config?account_id=${ACCT_B1}&channel=email`, {
          method: 'DELETE',
        }),
      )
      expect(res.status).toBe(403)
      expect(deleteChannelConfig).not.toHaveBeenCalled()
    })

    it('company_admin of A deleting own config → 200', async () => {
      fixture.authUserId = ADMIN_A_ID
      const res = await channelsDELETE(
        new Request(`http://x/api/channels/config?account_id=${ACCT_A1}&channel=email`, {
          method: 'DELETE',
        }),
      )
      expect(res.status).toBe(200)
    })

    it('super_admin deleting cross-tenant config → 200', async () => {
      fixture.authUserId = SUPER_ID
      const res = await channelsDELETE(
        new Request(`http://x/api/channels/config?account_id=${ACCT_B1}&channel=email`, {
          method: 'DELETE',
        }),
      )
      expect(res.status).toBe(200)
    })
  })
})

// ──────────────────────────────────────────────────────────────────────
// /api/accounts — DELETE (verifyAccountAccess gate)
// ──────────────────────────────────────────────────────────────────────

describe('/api/accounts DELETE cross-tenant isolation', () => {
  it('company_admin of A deleting company B account → 403 and row survives', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await accountsDELETE(
      new Request(`http://x/api/accounts?id=${ACCT_B1}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(403)
    // The cross-tenant account must NOT have been deleted.
    expect(fixture.accounts.has(ACCT_B1)).toBe(true)
    expect(fixture.deletes.some((d) => d.table === 'accounts')).toBe(false)
  })

  it('company_admin of A deleting own account → 200 and row removed', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await accountsDELETE(
      new Request(`http://x/api/accounts?id=${ACCT_A1}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(200)
    expect(fixture.accounts.has(ACCT_A1)).toBe(false)
  })

  it('super_admin deleting any account → 200', async () => {
    fixture.authUserId = SUPER_ID
    const res = await accountsDELETE(
      new Request(`http://x/api/accounts?id=${ACCT_B1}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(200)
    expect(fixture.accounts.has(ACCT_B1)).toBe(false)
  })

  it('unknown account id → 404 (before the scope check)', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await accountsDELETE(
      new Request('http://x/api/accounts?id=does-not-exist', { method: 'DELETE' }),
    )
    expect(res.status).toBe(404)
  })

  it('non-admin (company_member) → 403', async () => {
    fixture.authUserId = MEMBER_A_ID
    const res = await accountsDELETE(
      new Request(`http://x/api/accounts?id=${ACCT_A1}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(403)
    expect(fixture.accounts.has(ACCT_A1)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────
// /api/sheets-sync — GET scopes to own company; POST is admin-only
// ──────────────────────────────────────────────────────────────────────

describe('/api/sheets-sync cross-tenant isolation', () => {
  describe('GET (read scope)', () => {
    it('company_admin of A sees ONLY company A sheets', async () => {
      fixture.authUserId = ADMIN_A_ID
      const res = await sheetsGET()
      expect(res.status).toBe(200)
      const body = (await res.json()) as { sheets: Array<{ id: string; account_id: string }> }
      const ids = body.sheets.map((s) => s.id)
      expect(ids).toContain(SHEET_A1)
      expect(ids).not.toContain(SHEET_B1)
    })

    it('company_admin of B sees ONLY company B sheets', async () => {
      fixture.authUserId = ADMIN_B_ID
      const res = await sheetsGET()
      const body = (await res.json()) as { sheets: Array<{ id: string }> }
      const ids = body.sheets.map((s) => s.id)
      expect(ids).toContain(SHEET_B1)
      expect(ids).not.toContain(SHEET_A1)
    })

    it('non-admin member is still company-scoped (sees own, not other tenant)', async () => {
      fixture.authUserId = MEMBER_A_ID
      const res = await sheetsGET()
      const body = (await res.json()) as { sheets: Array<{ id: string }> }
      const ids = body.sheets.map((s) => s.id)
      expect(ids).toContain(SHEET_A1)
      expect(ids).not.toContain(SHEET_B1)
    })

    it('super_admin sees every tenant\'s sheets', async () => {
      fixture.authUserId = SUPER_ID
      const res = await sheetsGET()
      const body = (await res.json()) as { sheets: Array<{ id: string }> }
      const ids = body.sheets.map((s) => s.id)
      expect(ids).toContain(SHEET_A1)
      expect(ids).toContain(SHEET_B1)
    })

    it('unauthenticated → 401', async () => {
      fixture.authUserId = null
      const res = await sheetsGET()
      expect(res.status).toBe(401)
    })
  })

  describe('POST (admin-only write)', () => {
    it('non-admin (company_member) → 403 "Admin only"', async () => {
      fixture.authUserId = MEMBER_A_ID
      const res = await sheetsPOST(jsonReq('http://x/api/sheets-sync', {}))
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('Admin only')
    })

    it('unauthenticated → 401', async () => {
      fixture.authUserId = null
      const res = await sheetsPOST(jsonReq('http://x/api/sheets-sync', {}))
      expect(res.status).toBe(401)
    })

    it('company_admin scoped to own company: targeting another tenant\'s sheet id syncs nothing', async () => {
      // Admin A explicitly asks to sync SHEET_B1. The `.in(account_id, allowed)`
      // scope filter means the cross-tenant sheet is never selected, so the
      // route reports "No sheets to sync" instead of touching company B data.
      fixture.authUserId = ADMIN_A_ID
      const res = await sheetsPOST(
        jsonReq('http://x/api/sheets-sync', { sheet_sync_id: SHEET_B1 }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { message: string; synced?: unknown[] }
      expect(body.message).toBe('No sheets to sync')
      // Company B's sheet must not have been flipped to 'syncing'.
      expect(fixture.sheets.get(SHEET_B1)?.sync_status).toBe('active')
      expect(fixture.updates.some((u) => u.table === 'google_sheets_sync')).toBe(false)
    })
  })
})
