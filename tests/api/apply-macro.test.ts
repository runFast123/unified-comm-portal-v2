// Tests for POST /api/conversations/[id]/apply-macro.
//
// The route applies a saved macro (status / tags / assignee / priority) to a
// conversation and NEVER sends a message. Tests verify:
//   * Auth gating (401 / 400 / 404)
//   * Account-scope guard → 403 (assertAccountAccess says no)
//   * Cross-COMPANY macro vs conversation → 403
//   * Happy path applies actions + writes a conversation.macro_applied audit row
//   * reply_template_id is surfaced (insert_template_id) but no send happens

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

interface Conv {
  id: string
  account_id: string
  status?: string | null
  secondary_status?: string | null
  priority?: string | null
  tags?: string[] | null
  assigned_to?: string | null
}

interface Macro {
  id: string
  company_id: string
  name: string
  is_active?: boolean | null
  actions: Record<string, unknown> | null
}

const fixture = {
  // tenant-guard context (mocked below)
  guardOk: true,
  ctx: { userId: 'user-1', role: 'company_admin', companyId: 'co-1' as string | null, isSuperAdmin: false },
  accessAllowed: true,

  conversation: {
    id: 'conv-1',
    account_id: 'acct-1',
    status: 'active',
    secondary_status: null,
    priority: 'medium',
    tags: ['existing'],
    assigned_to: null,
  } as Conv | null,
  account: { company_id: 'co-1' } as { company_id: string | null } | null,
  macro: {
    id: 'macro-1',
    company_id: 'co-1',
    name: 'Triage urgent',
    is_active: true,
    actions: { set_priority: 'urgent', add_tags: ['vip'] },
  } as Macro | null,
  assignee: null as { id: string; company_id: string | null; full_name: string | null; email: string | null } | null,
  companyStatusRow: null as { id: string; name: string } | null,

  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      let lastEqId: string | null = null
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (col === 'id' && typeof val === 'string') lastEqId = val
          return chain
        },
        ilike: () => chain,
        limit: () => chain,
        order: () => chain,
        insert: (payload: Record<string, unknown>) => {
          fixture.inserts.push({ table, payload })
          return Promise.resolve({ data: null, error: null })
        },
        update: (payload: Record<string, unknown>) => {
          fixture.updates.push({ table, payload })
          return { eq: () => Promise.resolve({ data: null, error: null }) }
        },
        maybeSingle: async () => {
          if (table === 'conversations') return { data: fixture.conversation, error: null }
          if (table === 'accounts') return { data: fixture.account, error: null }
          if (table === 'macros') return { data: fixture.macro, error: null }
          if (table === 'users') return { data: fixture.assignee, error: null }
          if (table === 'company_statuses') return { data: fixture.companyStatusRow, error: null }
          return { data: null, error: null }
        },
      }
      void lastEqId
      return chain
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: fixture.ctx.userId } }, error: null }) },
  })),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

vi.mock('@/lib/tenant-guard', () => ({
  requireUser: vi.fn(async () =>
    fixture.guardOk
      ? { ok: true, ctx: fixture.ctx }
      : { ok: false, status: 401, error: 'Unauthorized' },
  ),
  assertAccountAccess: vi.fn(async () => fixture.accessAllowed),
}))

import { POST } from '@/app/api/conversations/[id]/apply-macro/route'

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
  fixture.guardOk = true
  fixture.ctx = { userId: 'user-1', role: 'company_admin', companyId: 'co-1', isSuperAdmin: false }
  fixture.accessAllowed = true
  fixture.conversation = {
    id: 'conv-1',
    account_id: 'acct-1',
    status: 'active',
    secondary_status: null,
    priority: 'medium',
    tags: ['existing'],
    assigned_to: null,
  }
  fixture.account = { company_id: 'co-1' }
  fixture.macro = {
    id: 'macro-1',
    company_id: 'co-1',
    name: 'Triage urgent',
    is_active: true,
    actions: { set_priority: 'urgent', add_tags: ['vip'] },
  }
  fixture.assignee = null
  fixture.companyStatusRow = null
  fixture.inserts = []
  fixture.updates = []
})

describe('POST /api/conversations/[id]/apply-macro', () => {
  it('401 when unauthenticated', async () => {
    fixture.guardOk = false
    const res = await POST(
      jsonReq('http://localhost/api/conversations/conv-1/apply-macro', { macro_id: 'macro-1' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(401)
  })

  it('400 when macro_id missing', async () => {
    const res = await POST(
      jsonReq('http://localhost/api/conversations/conv-1/apply-macro', {}),
      ctx('conv-1'),
    )
    expect(res.status).toBe(400)
  })

  it('404 when conversation not found', async () => {
    fixture.conversation = null
    const res = await POST(
      jsonReq('http://localhost/api/conversations/missing/apply-macro', { macro_id: 'macro-1' }),
      ctx('missing'),
    )
    expect(res.status).toBe(404)
  })

  it('403 when account scope mismatch (assertAccountAccess says no)', async () => {
    fixture.accessAllowed = false
    const res = await POST(
      jsonReq('http://localhost/api/conversations/conv-1/apply-macro', { macro_id: 'macro-1' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(403)
    // Nothing applied.
    expect(fixture.updates.find((u) => u.table === 'conversations')).toBeUndefined()
  })

  it('404 when macro not found', async () => {
    fixture.macro = null
    const res = await POST(
      jsonReq('http://localhost/api/conversations/conv-1/apply-macro', { macro_id: 'nope' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(404)
  })

  it('403 when the macro belongs to a DIFFERENT company than the conversation', async () => {
    // Conversation's account is co-1; macro is co-2. Caller is not super_admin.
    fixture.macro = {
      id: 'macro-x',
      company_id: 'co-2',
      name: 'Foreign macro',
      is_active: true,
      actions: { set_priority: 'urgent' },
    }
    const res = await POST(
      jsonReq('http://localhost/api/conversations/conv-1/apply-macro', { macro_id: 'macro-x' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(403)
    expect(fixture.updates.find((u) => u.table === 'conversations')).toBeUndefined()
  })

  it('422 when the conversation has no company linkage', async () => {
    fixture.account = { company_id: null }
    const res = await POST(
      jsonReq('http://localhost/api/conversations/conv-1/apply-macro', { macro_id: 'macro-1' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(422)
  })

  it('422 when the macro is inactive', async () => {
    fixture.macro = { ...(fixture.macro as Macro), is_active: false }
    const res = await POST(
      jsonReq('http://localhost/api/conversations/conv-1/apply-macro', { macro_id: 'macro-1' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(422)
  })

  it('200 happy path: applies actions + writes a macro_applied audit row', async () => {
    const res = await POST(
      jsonReq('http://localhost/api/conversations/conv-1/apply-macro', { macro_id: 'macro-1' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.applied).toContain('priority → urgent')

    const update = fixture.updates.find((u) => u.table === 'conversations')
    expect(update?.payload.priority).toBe('urgent')
    expect(update?.payload.tags).toEqual(['existing', 'vip'])

    const audit = fixture.inserts.find(
      (i) => i.table === 'audit_log' && i.payload.action === 'conversation.macro_applied',
    )
    expect(audit).toBeTruthy()
    expect((audit?.payload.details as any)?.macro_id).toBe('macro-1')
    expect(audit?.payload.entity_type).toBe('conversation')
  })

  it('422 when the macro assigns a cross-company user', async () => {
    fixture.macro = {
      id: 'macro-assign',
      company_id: 'co-1',
      name: 'Assign',
      is_active: true,
      actions: { assign_to: 'user-evil' },
    }
    // Assignee lives in a different company than the conversation (co-1).
    fixture.assignee = { id: 'user-evil', company_id: 'co-2', full_name: 'Mallory', email: 'm@x.example' }
    const res = await POST(
      jsonReq('http://localhost/api/conversations/conv-1/apply-macro', { macro_id: 'macro-assign' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(422)
    expect(fixture.updates.find((u) => u.table === 'conversations')).toBeUndefined()
  })

  it('surfaces insert_template_id and never touches a send/messages table', async () => {
    fixture.macro = {
      id: 'macro-tmpl',
      company_id: 'co-1',
      name: 'With template',
      is_active: true,
      actions: { reply_template_id: 'tmpl-42', set_priority: 'high' },
    }
    const res = await POST(
      jsonReq('http://localhost/api/conversations/conv-1/apply-macro', { macro_id: 'macro-tmpl' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.insert_template_id).toBe('tmpl-42')
    // The route must never write to messages / pending_sends.
    const sendWrites = [...fixture.inserts, ...fixture.updates].filter(
      (w) => w.table === 'messages' || w.table === 'pending_sends',
    )
    expect(sendWrites).toHaveLength(0)
  })

  it('super_admin may apply a macro across companies', async () => {
    fixture.ctx = { userId: 'su', role: 'super_admin', companyId: null, isSuperAdmin: true }
    fixture.macro = {
      id: 'macro-x',
      company_id: 'co-2',
      name: 'Foreign macro',
      is_active: true,
      actions: { set_priority: 'high' },
    }
    const res = await POST(
      jsonReq('http://localhost/api/conversations/conv-1/apply-macro', { macro_id: 'macro-x' }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(200)
  })
})
