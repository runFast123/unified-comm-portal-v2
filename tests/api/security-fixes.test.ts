// Smoke tests covering the eight cross-tenant-exposure / SSRF / injection
// fixes in this branch. Each describe block targets one fix and verifies
// the attack vector is blocked.
//
// We mock @/lib/supabase-server with a tiny in-memory fixture so the tests
// run synchronously and never touch the network. Each route is imported
// AFTER the mocks so it picks up the stubs.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
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
  is_active: boolean
}
interface AccountFx {
  id: string
  name: string
  is_active: boolean
  company_id: string | null
}
interface ConvFx {
  id: string
  account_id: string
  contact_id: string | null
}
interface ContactFx {
  id: string
  email?: string | null
  phone?: string | null
  display_name?: string | null
  notes?: string | null
  tags?: string[]
  is_vip?: boolean
}
interface CompanyFx {
  id: string
  name: string
  default_email_signature?: string | null
}

const fixture = {
  authUserId: null as string | null,
  users: new Map<string, UserFx>(),
  accounts: new Map<string, AccountFx>(),
  conversations: new Map<string, ConvFx>(),
  contacts: new Map<string, ContactFx>(),
  companies: new Map<string, CompanyFx>(),
  notes: [] as Array<Record<string, unknown>>,
  noteMentions: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<{ table: string; payload: unknown }>,
  updates: [] as Array<{ table: string; payload: unknown }>,
  // Storage stub
  storageList: [] as Array<{ name: string }>,
  storageListErr: null as { message: string } | null,
  storageSignedUrl: 'https://signed.example/x' as string | null,
  // Auth-admin stub for invite endpoint
  inviteResult: { data: { user: { id: 'auth-x' } as { id: string } | null }, error: null as { message: string } | null },
}

const SUPER_ID = 'user-super'
const ADMIN_A_ID = 'user-admin-a' // company A admin
const ADMIN_B_ID = 'user-admin-b' // company B admin
const MEMBER_A_ID = 'user-member-a'
const MEMBER_B_ID = 'user-member-b'
const COMP_A = 'comp-a'
const COMP_B = 'comp-b'
const ACCT_A1 = 'acct-a1'
const ACCT_B1 = 'acct-b1'

const CONV_A = '11111111-1111-1111-1111-111111111111'
const CONV_B = '22222222-2222-2222-2222-222222222222'
const CONTACT_A = 'contact-a-1'
const CONTACT_B = 'contact-b-1'

function reset() {
  fixture.authUserId = null
  fixture.users.clear()
  fixture.accounts.clear()
  fixture.conversations.clear()
  fixture.contacts.clear()
  fixture.companies.clear()
  fixture.notes.length = 0
  fixture.noteMentions.length = 0
  fixture.inserts.length = 0
  fixture.updates.length = 0
  fixture.storageList = [{ name: 'doc.pdf' }]
  fixture.storageListErr = null
  fixture.storageSignedUrl = 'https://signed.example/x'
  fixture.inviteResult = {
    data: { user: { id: 'auth-x' } },
    error: null,
  }

  fixture.companies.set(COMP_A, { id: COMP_A, name: 'Acme', default_email_signature: 'old' })
  fixture.companies.set(COMP_B, { id: COMP_B, name: 'Other Co', default_email_signature: 'old-b' })

  fixture.accounts.set(ACCT_A1, {
    id: ACCT_A1, name: 'Acme Email', is_active: true, company_id: COMP_A,
  })
  fixture.accounts.set(ACCT_B1, {
    id: ACCT_B1, name: 'B Email', is_active: true, company_id: COMP_B,
  })

  fixture.users.set(SUPER_ID, {
    id: SUPER_ID, email: 'super@x', full_name: 'Super',
    role: 'super_admin', account_id: null, company_id: null, is_active: true,
  })
  fixture.users.set(ADMIN_A_ID, {
    id: ADMIN_A_ID, email: 'a@x', full_name: 'A Admin',
    role: 'company_admin', account_id: ACCT_A1, company_id: COMP_A, is_active: true,
  })
  fixture.users.set(ADMIN_B_ID, {
    id: ADMIN_B_ID, email: 'b@x', full_name: 'B Admin',
    role: 'company_admin', account_id: ACCT_B1, company_id: COMP_B, is_active: true,
  })
  fixture.users.set(MEMBER_A_ID, {
    id: MEMBER_A_ID, email: 'm-a@x', full_name: 'A Member',
    role: 'company_member', account_id: ACCT_A1, company_id: COMP_A, is_active: true,
  })
  fixture.users.set(MEMBER_B_ID, {
    id: MEMBER_B_ID, email: 'm-b@example.com', full_name: 'B Member',
    role: 'company_member', account_id: ACCT_B1, company_id: COMP_B, is_active: true,
  })

  fixture.conversations.set(CONV_A, { id: CONV_A, account_id: ACCT_A1, contact_id: CONTACT_A })
  fixture.conversations.set(CONV_B, { id: CONV_B, account_id: ACCT_B1, contact_id: CONTACT_B })

  fixture.contacts.set(CONTACT_A, { id: CONTACT_A, email: 'ca@x', display_name: 'CA' })
  fixture.contacts.set(CONTACT_B, { id: CONTACT_B, email: 'cb@x', display_name: 'CB' })
}

// ──────────────────────────────────────────────────────────────────────
// Tiny supabase-shaped fluent builder
// ──────────────────────────────────────────────────────────────────────

interface Filter {
  kind: 'eq' | 'in' | 'is' | 'ilike'
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
    } else if (f.kind === 'ilike') {
      const v = String(row[f.col] ?? '').toLowerCase()
      const pat = String(f.value).toLowerCase()
      // Cheap ILIKE — we only ever pass `prefix%`.
      if (pat.endsWith('%')) {
        const prefix = pat.slice(0, -1).replace(/\\(.)/g, '$1')
        if (!v.startsWith(prefix)) return false
      } else if (v !== pat) {
        return false
      }
    }
  }
  return true
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      const filters: Filter[] = []
      let mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
      let mutationPayload: Record<string, unknown> | Array<Record<string, unknown>> | null = null
      let countMode = false

      const chain: Record<string, unknown> = {}
      const self = chain as any

      self.select = (_cols?: string, opts?: { count?: 'exact'; head?: boolean }) => {
        if (opts?.count === 'exact') countMode = true
        return self
      }
      self.eq = (col: string, value: unknown) => { filters.push({ kind: 'eq', col, value }); return self }
      self.in = (col: string, value: unknown) => { filters.push({ kind: 'in', col, value }); return self }
      self.is = (col: string, value: unknown) => { filters.push({ kind: 'is', col, value }); return self }
      self.ilike = (col: string, value: unknown) => { filters.push({ kind: 'ilike', col, value }); return self }
      self.or = () => self
      self.order = () => self
      self.limit = () => self
      self.gte = () => self
      self.range = () => self
      self.insert = (payload: any) => { mode = 'insert'; mutationPayload = payload; return self }
      self.update = (payload: any) => { mode = 'update'; mutationPayload = payload; return self }
      self.delete = () => { mode = 'delete'; return self }

      const tableMap: Record<string, Map<string, Record<string, unknown>>> = {
        users: fixture.users as unknown as Map<string, Record<string, unknown>>,
        accounts: fixture.accounts as unknown as Map<string, Record<string, unknown>>,
        conversations: fixture.conversations as unknown as Map<string, Record<string, unknown>>,
        contacts: fixture.contacts as unknown as Map<string, Record<string, unknown>>,
        companies: fixture.companies as unknown as Map<string, Record<string, unknown>>,
      }

      const terminal = async (): Promise<{ data: unknown; error: unknown; count?: number }> => {
        if (mode === 'insert') {
          if (table === 'conversation_notes' && mutationPayload && !Array.isArray(mutationPayload)) {
            const row = { id: `note-${fixture.notes.length + 1}`, ...(mutationPayload as object) }
            fixture.notes.push(row)
            return { data: row, error: null }
          }
          if (table === 'note_mentions') {
            const arr = Array.isArray(mutationPayload) ? mutationPayload : [mutationPayload as Record<string, unknown>]
            const inserted = arr.map((p, i) => ({ id: `nm-${fixture.noteMentions.length + i + 1}`, ...p }))
            fixture.noteMentions.push(...inserted)
            return { data: inserted, error: null }
          }
          fixture.inserts.push({ table, payload: mutationPayload })
          if (table === 'users' && mutationPayload && !Array.isArray(mutationPayload)) {
            const row = { id: (mutationPayload as { id?: string }).id ?? `u-${fixture.users.size + 1}`, ...(mutationPayload as object) } as UserFx
            fixture.users.set(row.id, row)
            return { data: row, error: null }
          }
          // audit_log writes don't need to round-trip
          return { data: { id: 'audit-row' }, error: null }
        }

        const map = tableMap[table]
        if (mode === 'update' && map) {
          fixture.updates.push({ table, payload: mutationPayload })
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

        if (mode === 'delete' && map) {
          let deleted: Record<string, unknown> | null = null
          for (const [k, row] of Array.from(map.entries())) {
            if (rowMatches(row as Record<string, unknown>, filters)) {
              map.delete(k)
              deleted = row as Record<string, unknown>
              break
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

    // Storage stub for the signed-url route
    storage: {
      from: (_bucket: string) => ({
        list: async (_prefix: string, _opts?: unknown) => ({
          data: fixture.storageList,
          error: fixture.storageListErr,
        }),
        createSignedUrl: async (_path: string, _ttl: number) => ({
          data: fixture.storageSignedUrl ? { signedUrl: fixture.storageSignedUrl } : null,
          error: null,
        }),
      }),
    },

    // Auth-admin stub for invite route
    auth: {
      admin: {
        inviteUserByEmail: async () => fixture.inviteResult,
      },
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

// audit logger uses service-role internally — the mock above makes it inert.
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }))

// nodemailer used by /api/notes — stub createTransport so no SMTP is attempted.
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async () => ({}),
    }),
  },
}))

// ──────────────────────────────────────────────────────────────────────
// Imports — AFTER mocks
// ──────────────────────────────────────────────────────────────────────

import { GET as signedUrlGet } from '@/app/api/attachments/signed-url/route'
import { POST as signaturePost } from '@/app/api/admin/companies/[id]/signature/route'
import { GET as userSearchGet } from '@/app/api/users/search/route'
import { PATCH as contactPatch, DELETE as contactDelete } from '@/app/api/contacts/[id]/route'
import { POST as usersUpdate } from '@/app/api/users/update/route'
import { POST as notesPost } from '@/app/api/notes/route'
import { POST as inviteUser } from '@/app/api/admin/companies/[id]/users/invite/route'
import { POST as createWebhook } from '@/app/api/admin/webhooks/route'
import { validatePublicHttpsUrl } from '@/lib/url-validator'

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

afterEach(() => {
  vi.clearAllMocks()
})

// ──────────────────────────────────────────────────────────────────────
// FIX 1: IDOR on attachment signed URLs
// ──────────────────────────────────────────────────────────────────────

describe('FIX 1: signed-url path-prefix IDOR', () => {
  it('rejects when path owner segment is a different user → 403', async () => {
    fixture.authUserId = MEMBER_A_ID
    // Attacker crafts a path where segments[0] is some OTHER user's id.
    const url = `http://x/api/attachments/signed-url?path=${ADMIN_A_ID}/${CONV_A}/doc.pdf`
    const res = await signedUrlGet(new Request(url))
    expect(res.status).toBe(403)
  })

  it('rejects when conversation belongs to another company → 403', async () => {
    fixture.authUserId = MEMBER_A_ID
    // Owner segment matches caller, but conversation belongs to COMP_B.
    const url = `http://x/api/attachments/signed-url?path=${MEMBER_A_ID}/${CONV_B}/doc.pdf`
    const res = await signedUrlGet(new Request(url))
    expect(res.status).toBe(403)
  })

  it('rejects when storage object does not exist at path → 404', async () => {
    fixture.authUserId = MEMBER_A_ID
    fixture.storageList = [] // nothing at that prefix
    const url = `http://x/api/attachments/signed-url?path=${MEMBER_A_ID}/${CONV_A}/doc.pdf`
    const res = await signedUrlGet(new Request(url))
    expect(res.status).toBe(404)
  })

  it('happy path → 200 + signed url', async () => {
    fixture.authUserId = MEMBER_A_ID
    fixture.storageList = [{ name: 'doc.pdf' }]
    const url = `http://x/api/attachments/signed-url?path=${MEMBER_A_ID}/${CONV_A}/doc.pdf`
    const res = await signedUrlGet(new Request(url))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string }
    expect(body.url).toMatch(/^https:/)
  })
})

// ──────────────────────────────────────────────────────────────────────
// FIX 2: Cross-company signature overwrite
// ──────────────────────────────────────────────────────────────────────

describe('FIX 2: company signature is company-scoped', () => {
  it('company_admin of A cannot overwrite company B signature → 403', async () => {
    fixture.authUserId = ADMIN_A_ID
    const ctx = { params: Promise.resolve({ id: COMP_B }) }
    const res = await signaturePost(
      jsonReq(`http://x/api/admin/companies/${COMP_B}/signature`, {
        default_email_signature: 'pwned',
      }),
      ctx,
    )
    expect(res.status).toBe(403)
    expect(fixture.companies.get(COMP_B)?.default_email_signature).toBe('old-b')
  })

  it('company_admin of A can update their own signature → 200', async () => {
    fixture.authUserId = ADMIN_A_ID
    const ctx = { params: Promise.resolve({ id: COMP_A }) }
    const res = await signaturePost(
      jsonReq(`http://x/api/admin/companies/${COMP_A}/signature`, {
        default_email_signature: 'new sig',
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(fixture.companies.get(COMP_A)?.default_email_signature).toBe('new sig')
  })

  it('super_admin can cross-tenant write → 200', async () => {
    fixture.authUserId = SUPER_ID
    const ctx = { params: Promise.resolve({ id: COMP_B }) }
    const res = await signaturePost(
      jsonReq(`http://x/api/admin/companies/${COMP_B}/signature`, {
        default_email_signature: 'hello',
      }),
      ctx,
    )
    expect(res.status).toBe(200)
  })
})

// ──────────────────────────────────────────────────────────────────────
// FIX 3: PostgREST .or() injection
// ──────────────────────────────────────────────────────────────────────

describe('FIX 3: user-search .or() injection', () => {
  it('rejects q containing comma → 400', async () => {
    fixture.authUserId = ADMIN_A_ID
    const url = `http://x/api/users/search?q=${encodeURIComponent('foo,id.eq.x')}`
    const res = await userSearchGet(new Request(url))
    expect(res.status).toBe(400)
  })

  it('rejects q containing parentheses → 400', async () => {
    fixture.authUserId = ADMIN_A_ID
    const url = `http://x/api/users/search?q=${encodeURIComponent('foo(or)')}`
    const res = await userSearchGet(new Request(url))
    expect(res.status).toBe(400)
  })

  it('legacy admin role no longer sees cross-company users', async () => {
    // Mark ADMIN_A as the legacy literal `admin` role. They must STILL be
    // scoped to COMP_A — only super_admin sees everyone.
    const a = fixture.users.get(ADMIN_A_ID)!
    a.role = 'admin'
    fixture.authUserId = ADMIN_A_ID
    const url = `http://x/api/users/search?q=`
    const res = await userSearchGet(new Request(url))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: Array<{ id: string }> }
    const ids = body.users.map((u) => u.id)
    expect(ids).not.toContain(MEMBER_B_ID)
    expect(ids).not.toContain(ADMIN_B_ID)
  })
})

// ──────────────────────────────────────────────────────────────────────
// FIX 4: Open contact mutation
// ──────────────────────────────────────────────────────────────────────

describe('FIX 4: contact PATCH/DELETE require company-scoped access', () => {
  it('PATCH on contact in another company → 403', async () => {
    fixture.authUserId = MEMBER_A_ID
    const res = await contactPatch(
      jsonReq(`http://x/api/contacts/${CONTACT_B}`, { display_name: 'pwned' }, 'PATCH'),
      { params: Promise.resolve({ id: CONTACT_B }) },
    )
    expect(res.status).toBe(403)
    expect(fixture.contacts.get(CONTACT_B)?.display_name).toBe('CB')
  })

  it('PATCH on contact in own company → 200', async () => {
    fixture.authUserId = MEMBER_A_ID
    const res = await contactPatch(
      jsonReq(`http://x/api/contacts/${CONTACT_A}`, { display_name: 'CA renamed' }, 'PATCH'),
      { params: Promise.resolve({ id: CONTACT_A }) },
    )
    expect(res.status).toBe(200)
    expect(fixture.contacts.get(CONTACT_A)?.display_name).toBe('CA renamed')
  })

  it('DELETE by company_admin of B against contact A → 403', async () => {
    fixture.authUserId = ADMIN_B_ID
    const res = await contactDelete(
      new Request(`http://x/api/contacts/${CONTACT_A}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: CONTACT_A }) },
    )
    expect(res.status).toBe(403)
    expect(fixture.contacts.has(CONTACT_A)).toBe(true)
  })

  it('DELETE by company_member (non-admin) → 403 even in own company', async () => {
    fixture.authUserId = MEMBER_A_ID
    const res = await contactDelete(
      new Request(`http://x/api/contacts/${CONTACT_A}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: CONTACT_A }) },
    )
    expect(res.status).toBe(403)
  })
})

// ──────────────────────────────────────────────────────────────────────
// FIX 5: /api/users/update cross-company
// ──────────────────────────────────────────────────────────────────────

describe('FIX 5: users/update cross-company guard', () => {
  it('company_admin of A cannot mutate user in B → 403', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await usersUpdate(
      jsonReq('http://x/api/users/update', {
        user_id: MEMBER_B_ID,
        is_active: false,
      }),
    )
    expect(res.status).toBe(403)
    expect(fixture.users.get(MEMBER_B_ID)?.is_active).toBe(true)
  })

  it('company_admin of A cannot reassign their member to ACCT_B1 → 403', async () => {
    fixture.authUserId = ADMIN_A_ID
    const res = await usersUpdate(
      jsonReq('http://x/api/users/update', {
        user_id: MEMBER_A_ID,
        account_id: ACCT_B1,
      }),
    )
    expect(res.status).toBe(403)
    expect(fixture.users.get(MEMBER_A_ID)?.account_id).toBe(ACCT_A1)
  })

  it('legacy admin role is gated → 403 when crossing companies', async () => {
    const a = fixture.users.get(ADMIN_A_ID)!
    a.role = 'admin'
    fixture.authUserId = ADMIN_A_ID
    const res = await usersUpdate(
      jsonReq('http://x/api/users/update', { user_id: MEMBER_B_ID, is_active: false }),
    )
    expect(res.status).toBe(403)
  })

  it('super_admin can move a user across companies → 200', async () => {
    fixture.authUserId = SUPER_ID
    const res = await usersUpdate(
      jsonReq('http://x/api/users/update', {
        user_id: MEMBER_A_ID,
        account_id: ACCT_B1,
      }),
    )
    expect(res.status).toBe(200)
  })
})

// ──────────────────────────────────────────────────────────────────────
// FIX 6: Notes API cross-company
// ──────────────────────────────────────────────────────────────────────

describe('FIX 6: notes route enforces account scope + scopes mentions', () => {
  it('member of A cannot post a note on conversation in B → 403', async () => {
    fixture.authUserId = MEMBER_A_ID
    const res = await notesPost(
      jsonReq('http://x/api/notes', {
        conversation_id: CONV_B,
        note_text: 'hi',
      }),
    )
    expect(res.status).toBe(403)
  })

  it('drops cross-company mentions silently', async () => {
    fixture.authUserId = MEMBER_A_ID
    // Mention MEMBER_B_ID — must NOT result in a note_mentions row.
    const noteText = `hello @[B Member](${MEMBER_B_ID})`
    const res = await notesPost(
      jsonReq('http://x/api/notes', {
        conversation_id: CONV_A,
        note_text: noteText,
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mentioned_user_ids: string[] }
    expect(body.mentioned_user_ids).not.toContain(MEMBER_B_ID)
    expect(fixture.noteMentions.find((m) => m.mentioned_user_id === MEMBER_B_ID)).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────────
// FIX 7: User invite hostile takeover
// ──────────────────────────────────────────────────────────────────────

describe('FIX 7: invite cannot steal a user from another company', () => {
  it('company_admin of A inviting an email already in B → 409', async () => {
    fixture.authUserId = ADMIN_A_ID
    const ctx = { params: Promise.resolve({ id: COMP_A }) }
    const res = await inviteUser(
      jsonReq(`http://x/api/admin/companies/${COMP_A}/users/invite`, {
        email: 'm-b@example.com', // belongs to MEMBER_B_ID in COMP_B
        role: 'company_member',
      }),
      ctx,
    )
    expect(res.status).toBe(409)
    expect(fixture.users.get(MEMBER_B_ID)?.company_id).toBe(COMP_B)
  })

  it('super_admin can transfer the same user → 200', async () => {
    fixture.authUserId = SUPER_ID
    const ctx = { params: Promise.resolve({ id: COMP_A }) }
    const res = await inviteUser(
      jsonReq(`http://x/api/admin/companies/${COMP_A}/users/invite`, {
        email: 'm-b@example.com',
        role: 'company_member',
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(fixture.users.get(MEMBER_B_ID)?.company_id).toBe(COMP_A)
  })
})

// ──────────────────────────────────────────────────────────────────────
// FIX 8: Outgoing webhook SSRF
// ──────────────────────────────────────────────────────────────────────

describe('FIX 8: webhook SSRF validator + endpoint integration', () => {
  describe('validatePublicHttpsUrl unit tests', () => {
    it('rejects http://', async () => {
      const r = await validatePublicHttpsUrl('http://example.com/hook')
      expect(r.ok).toBe(false)
    })
    it('rejects file://', async () => {
      const r = await validatePublicHttpsUrl('file:///etc/passwd')
      expect(r.ok).toBe(false)
    })
    it('rejects literal 127.0.0.1', async () => {
      const r = await validatePublicHttpsUrl('https://127.0.0.1/x')
      expect(r.ok).toBe(false)
    })
    it('rejects literal 169.254.169.254 (AWS IMDS)', async () => {
      const r = await validatePublicHttpsUrl('https://169.254.169.254/latest/meta-data/')
      expect(r.ok).toBe(false)
    })
    it('rejects RFC1918 10/8', async () => {
      const r = await validatePublicHttpsUrl('https://10.0.0.5/x')
      expect(r.ok).toBe(false)
    })
    it('rejects RFC1918 192.168/16', async () => {
      const r = await validatePublicHttpsUrl('https://192.168.1.1/x')
      expect(r.ok).toBe(false)
    })
    it('rejects RFC1918 172.16/12', async () => {
      const r = await validatePublicHttpsUrl('https://172.16.0.1/x')
      expect(r.ok).toBe(false)
    })
    it('rejects 100.64/10 carrier-grade NAT', async () => {
      const r = await validatePublicHttpsUrl('https://100.64.0.1/x')
      expect(r.ok).toBe(false)
    })
    it('rejects IPv6 ::1', async () => {
      const r = await validatePublicHttpsUrl('https://[::1]/x')
      expect(r.ok).toBe(false)
    })
    it('rejects fc00::/7 ULA', async () => {
      const r = await validatePublicHttpsUrl('https://[fc00::1]/x')
      expect(r.ok).toBe(false)
    })
    it('rejects fe80::/10 link-local', async () => {
      const r = await validatePublicHttpsUrl('https://[fe80::1]/x')
      expect(r.ok).toBe(false)
    })
    it('rejects localhost hostname', async () => {
      const r = await validatePublicHttpsUrl('https://localhost/x')
      expect(r.ok).toBe(false)
    })
    it('rejects *.internal hostname', async () => {
      const r = await validatePublicHttpsUrl('https://api.internal/x')
      expect(r.ok).toBe(false)
    })
    it('rejects malformed URL', async () => {
      const r = await validatePublicHttpsUrl('not a url')
      expect(r.ok).toBe(false)
    })
  })

  describe('POST /api/admin/webhooks integration', () => {
    it('rejects http URL → 400', async () => {
      fixture.authUserId = ADMIN_A_ID
      const res = await createWebhook(
        jsonReq('http://x/api/admin/webhooks', {
          url: 'http://example.com/hook',
          events: ['conversation.created'],
        }),
      )
      expect(res.status).toBe(400)
    })

    it('rejects 169.254.169.254 → 400', async () => {
      fixture.authUserId = ADMIN_A_ID
      const res = await createWebhook(
        jsonReq('http://x/api/admin/webhooks', {
          url: 'https://169.254.169.254/latest/meta-data/',
          events: ['conversation.created'],
        }),
      )
      expect(res.status).toBe(400)
    })

    it('rejects localhost hostname → 400', async () => {
      fixture.authUserId = ADMIN_A_ID
      const res = await createWebhook(
        jsonReq('http://x/api/admin/webhooks', {
          url: 'https://localhost/x',
          events: ['conversation.created'],
        }),
      )
      expect(res.status).toBe(400)
    })
  })
})
