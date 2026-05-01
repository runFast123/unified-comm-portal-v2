// Tests for POST /api/conversations/[id]/status and
//             POST /api/conversations/[id]/assign.
//
// Both endpoints exist primarily so the change is recorded in audit_log →
// surfaces on the conversation activity timeline. Tests verify:
//   * Auth gating (401 / 403 / 404)
//   * Validation of the body
//   * The audit_log insert actually fires on a real change

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

interface Conv {
  id: string
  account_id: string
  status?: string
  secondary_status?: string | null
  secondary_status_color?: string | null
  assigned_to?: string | null
}

const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  conversation: {
    id: 'conv-1',
    account_id: 'acct-1',
    status: 'active',
    secondary_status: null,
    secondary_status_color: null,
    assigned_to: null,
  } as Conv | null,
  accessAllowed: true,
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  // The H6 fix in /assign now does THREE separate users/accounts lookups:
  //   1. assignee (full_name, email, company_id, role)
  //   2. account → company_id (so we can compare against assignee.company_id)
  //   3. caller's role (super_admin bypasses the company match check)
  // The mock returns these via three separate fixture slots so each test can
  // shape the auth scenario it cares about.
  userLookup: null as { full_name: string | null; email: string; company_id?: string | null; role?: string } | null,
  accountLookup: { company_id: 'co-1' } as { company_id: string | null } | null,
  callerProfile: { role: 'super_admin' } as { role: string } | null,
  updateError: null as { message: string } | null,
}

function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: fixture.user }, error: null }),
    },
  }
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      let lastEqId: string | null = null
      const chain: any = {
        _table: table,
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (col === 'id' && typeof val === 'string') lastEqId = val
          return chain
        },
        insert: (payload: Record<string, unknown>) => {
          fixture.inserts.push({ table, payload })
          return Promise.resolve({ data: null, error: null })
        },
        update: (payload: Record<string, unknown>) => {
          fixture.updates.push({ table, payload })
          return {
            eq: () => Promise.resolve({ data: null, error: fixture.updateError }),
          }
        },
        maybeSingle: async () => {
          if (table === 'conversations') {
            return { data: fixture.conversation, error: null }
          }
          if (table === 'accounts') {
            return { data: fixture.accountLookup, error: null }
          }
          if (table === 'users') {
            // The route does two distinct user lookups: assignee (by user_id
            // from body) and caller (by auth.uid). When the .eq filter
            // matches the calling user, return the caller fixture; otherwise
            // return the assignee fixture (legacy behavior).
            if (lastEqId && fixture.user && lastEqId === fixture.user.id) {
              return { data: fixture.callerProfile, error: null }
            }
            return { data: fixture.userLookup, error: null }
          }
          return { data: null, error: null }
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

vi.mock('@/lib/api-helpers', () => ({
  verifyAccountAccess: vi.fn(async () => fixture.accessAllowed),
}))

import { POST as POST_STATUS } from '@/app/api/conversations/[id]/status/route'
import { POST as POST_ASSIGN } from '@/app/api/conversations/[id]/assign/route'

function jsonReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  fixture.user = { id: 'user-1' }
  fixture.conversation = {
    id: 'conv-1',
    account_id: 'acct-1',
    status: 'active',
    secondary_status: null,
    secondary_status_color: null,
    assigned_to: null,
  }
  fixture.accessAllowed = true
  fixture.inserts = []
  fixture.updates = []
  fixture.userLookup = null
  fixture.accountLookup = { company_id: 'co-1' }
  fixture.callerProfile = { role: 'super_admin' }
  fixture.updateError = null
})

// ── /status ────────────────────────────────────────────────────────────────
describe('POST /api/conversations/[id]/status', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', { status: 'resolved' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(401)
  })

  it('400 when neither status nor secondary_status is provided', async () => {
    const res = await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', {}),
      ctx('conv-1'),
    )
    expect(res.status).toBe(400)
  })

  it('400 when status is invalid', async () => {
    const res = await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', { status: 'wat' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(400)
  })

  it('404 when conversation not found', async () => {
    fixture.conversation = null
    const res = await POST_STATUS(
      jsonReq('http://localhost/api/conversations/missing/status', { status: 'resolved' }),
      ctx('missing'),
    )
    expect(res.status).toBe(404)
  })

  it('403 when account scope mismatch', async () => {
    fixture.accessAllowed = false
    const res = await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', { status: 'resolved' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(403)
  })

  it('200 happy path: updates status and writes an audit row', async () => {
    const res = await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', { status: 'resolved' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(200)
    // conversation update fired
    const update = fixture.updates.find((u) => u.table === 'conversations')
    expect(update?.payload).toEqual({ status: 'resolved' })
    // audit row written
    const audit = fixture.inserts.find(
      (i) => i.table === 'audit_log' && i.payload.action === 'conversation.status_changed',
    )
    expect(audit).toBeTruthy()
    expect((audit?.payload.details as any)?.from).toBe('active')
    expect((audit?.payload.details as any)?.to).toBe('resolved')
    expect(audit?.payload.entity_type).toBe('conversation')
    expect(audit?.payload.entity_id).toBe('conv-1')
  })

  it('does not write an audit row when status is unchanged', async () => {
    const res = await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', { status: 'active' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(200)
    const audit = fixture.inserts.find(
      (i) => i.table === 'audit_log' && i.payload.action === 'conversation.status_changed',
    )
    expect(audit).toBeUndefined()
  })

  it('writes secondary_status_changed when sub-status is set', async () => {
    const res = await POST_STATUS(
      jsonReq('http://localhost/api/conversations/conv-1/status', {
        secondary_status: 'awaiting_legal',
        secondary_status_color: '#ff00aa',
      }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(200)
    const audit = fixture.inserts.find(
      (i) => i.table === 'audit_log' && i.payload.action === 'conversation.secondary_status_changed',
    )
    expect(audit).toBeTruthy()
    expect((audit?.payload.details as any)?.to).toBe('awaiting_legal')
  })
})

// ── /assign ────────────────────────────────────────────────────────────────
describe('POST /api/conversations/[id]/assign', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await POST_ASSIGN(
      jsonReq('http://localhost/api/conversations/conv-1/assign', { user_id: 'user-2' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(401)
  })

  it('400 when user_id is wrong type', async () => {
    const res = await POST_ASSIGN(
      jsonReq('http://localhost/api/conversations/conv-1/assign', { user_id: 12 }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(400)
  })

  it('404 when conversation not found', async () => {
    fixture.conversation = null
    const res = await POST_ASSIGN(
      jsonReq('http://localhost/api/conversations/missing/assign', { user_id: 'user-2' }),
      ctx('missing'),
    )
    expect(res.status).toBe(404)
  })

  it('403 when account scope mismatch', async () => {
    fixture.accessAllowed = false
    const res = await POST_ASSIGN(
      jsonReq('http://localhost/api/conversations/conv-1/assign', { user_id: 'user-2' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(403)
  })

  it('200 happy path: assigns + writes a conversation.assigned audit row', async () => {
    // H6 fix: assignee must include company_id matching the conversation's
    // account.company_id (or caller is super_admin, which the default
    // callerProfile fixture sets).
    fixture.userLookup = { full_name: 'Aman', email: 'aman@x.example', company_id: 'co-1', role: 'company_member' }
    const res = await POST_ASSIGN(
      jsonReq('http://localhost/api/conversations/conv-1/assign', { user_id: 'user-2' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(200)
    const update = fixture.updates.find((u) => u.table === 'conversations')
    expect(update?.payload).toEqual({ assigned_to: 'user-2' })
    const audit = fixture.inserts.find(
      (i) => i.table === 'audit_log' && i.payload.action === 'conversation.assigned',
    )
    expect(audit).toBeTruthy()
    expect((audit?.payload.details as any)?.new_assignee_id).toBe('user-2')
    expect((audit?.payload.details as any)?.new_assignee_name).toBe('Aman')
  })

  it('200 happy path: unassigns + writes a conversation.unassigned audit row', async () => {
    fixture.conversation = {
      id: 'conv-1',
      account_id: 'acct-1',
      assigned_to: 'user-2',
    }
    const res = await POST_ASSIGN(
      jsonReq('http://localhost/api/conversations/conv-1/assign', { user_id: null }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(200)
    const audit = fixture.inserts.find(
      (i) => i.table === 'audit_log' && i.payload.action === 'conversation.unassigned',
    )
    expect(audit).toBeTruthy()
    expect((audit?.payload.details as any)?.previous_assignee_id).toBe('user-2')
    expect((audit?.payload.details as any)?.new_assignee_id).toBeNull()
  })

  it('does not write an audit row when assignee is unchanged', async () => {
    fixture.conversation = {
      id: 'conv-1',
      account_id: 'acct-1',
      assigned_to: 'user-2',
    }
    fixture.userLookup = { full_name: 'Aman', email: 'aman@x.example', company_id: 'co-1', role: 'company_member' }
    const res = await POST_ASSIGN(
      jsonReq('http://localhost/api/conversations/conv-1/assign', { user_id: 'user-2' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(200)
    const audit = fixture.inserts.find(
      (i) => i.table === 'audit_log' &&
        (i.payload.action === 'conversation.assigned' ||
         i.payload.action === 'conversation.unassigned'),
    )
    expect(audit).toBeUndefined()
  })
})
