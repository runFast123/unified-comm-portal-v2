// Tests for POST /api/conversations/[id]/mark-replied — the guarded route the
// inbox bulk "Mark Replied" / "Archive" / "Resolve" actions call instead of
// writing the `messages` table directly from the browser Supabase client.
//
// The whole point of the route is to close an intra-tenant RBAC gap: the
// conversations/messages UPDATE RLS is only company+channel scoped, so a
// within-company user whom an admin restricted (denied action:message.send)
// could previously still mutate from the inbox. These tests verify the gate
// stack (401 / 404 / 403 account / 403 permission / 403 channel) and the
// messages update + audit side-effects.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

interface Conv {
  id: string
  account_id: string
  channel?: string | null
}

const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  conversation: { id: 'conv-1', account_id: 'acct-1', channel: 'email' } as Conv | null,
  accessAllowed: true,
  canSend: true,
  canChannel: true,
  updatedRows: [{ id: 'm1' }, { id: 'm2' }] as Array<{ id: string }> | null,
  updateError: null as { message: string } | null,
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
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
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        insert: (payload: Record<string, unknown>) => {
          fixture.inserts.push({ table, payload })
          return Promise.resolve({ data: null, error: null })
        },
        // messages update is `.update().eq().eq().select()` → returns the rows.
        update: (payload: Record<string, unknown>) => {
          fixture.updates.push({ table, payload })
          const updChain: any = {
            eq: () => updChain,
            select: () =>
              Promise.resolve({ data: fixture.updatedRows, error: fixture.updateError }),
          }
          return updChain
        },
        maybeSingle: async () => {
          if (table === 'conversations') return { data: fixture.conversation, error: null }
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

vi.mock('@/lib/permissions/server', () => ({
  userIdCan: vi.fn(async () => fixture.canSend),
}))

vi.mock('@/lib/permissions/channel-access', () => ({
  userCanAccessConversationChannel: vi.fn(async () => fixture.canChannel),
}))

import { POST as POST_MARK } from '@/app/api/conversations/[id]/mark-replied/route'

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
  fixture.conversation = { id: 'conv-1', account_id: 'acct-1', channel: 'email' }
  fixture.accessAllowed = true
  fixture.canSend = true
  fixture.canChannel = true
  fixture.updatedRows = [{ id: 'm1' }, { id: 'm2' }]
  fixture.updateError = null
  fixture.inserts = []
  fixture.updates = []
})

describe('POST /api/conversations/[id]/mark-replied', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await POST_MARK(
      jsonReq('http://localhost/api/conversations/conv-1/mark-replied', {}),
      ctx('conv-1'),
    )
    expect(res.status).toBe(401)
  })

  it('404 when conversation not found', async () => {
    fixture.conversation = null
    const res = await POST_MARK(
      jsonReq('http://localhost/api/conversations/missing/mark-replied', {}),
      ctx('missing'),
    )
    expect(res.status).toBe(404)
  })

  it('403 when account scope mismatch', async () => {
    fixture.accessAllowed = false
    const res = await POST_MARK(
      jsonReq('http://localhost/api/conversations/conv-1/mark-replied', {}),
      ctx('conv-1'),
    )
    expect(res.status).toBe(403)
  })

  it('403 when caller lacks action:message.send (the intra-tenant gap)', async () => {
    fixture.canSend = false
    const res = await POST_MARK(
      jsonReq('http://localhost/api/conversations/conv-1/mark-replied', {}),
      ctx('conv-1'),
    )
    expect(res.status).toBe(403)
    // The guard must run BEFORE any write — no messages update fired.
    expect(fixture.updates.find((u) => u.table === 'messages')).toBeUndefined()
  })

  it('403 when caller cannot access the conversation channel', async () => {
    fixture.canChannel = false
    const res = await POST_MARK(
      jsonReq('http://localhost/api/conversations/conv-1/mark-replied', {}),
      ctx('conv-1'),
    )
    expect(res.status).toBe(403)
    expect(fixture.updates.find((u) => u.table === 'messages')).toBeUndefined()
  })

  it('200 happy path: marks inbound messages replied + writes an audit row', async () => {
    const res = await POST_MARK(
      jsonReq('http://localhost/api/conversations/conv-1/mark-replied', {}),
      ctx('conv-1'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.updated).toBe(2)
    const update = fixture.updates.find((u) => u.table === 'messages')
    expect(update?.payload).toEqual({ replied: true, reply_required: false })
    const audit = fixture.inserts.find(
      (i) => i.table === 'audit_log' && i.payload.action === 'conversation.messages_replied',
    )
    expect(audit).toBeTruthy()
    expect((audit?.payload.details as any)?.cleared_spam).toBe(false)
    expect((audit?.payload.details as any)?.messages_updated).toBe(2)
  })

  it('clear_spam:true also flips is_spam off (the inbox Archive action)', async () => {
    const res = await POST_MARK(
      jsonReq('http://localhost/api/conversations/conv-1/mark-replied', { clear_spam: true }),
      ctx('conv-1'),
    )
    expect(res.status).toBe(200)
    const update = fixture.updates.find((u) => u.table === 'messages')
    expect(update?.payload).toEqual({ replied: true, reply_required: false, is_spam: false })
    const audit = fixture.inserts.find(
      (i) => i.table === 'audit_log' && i.payload.action === 'conversation.messages_replied',
    )
    expect((audit?.payload.details as any)?.cleared_spam).toBe(true)
  })
})
