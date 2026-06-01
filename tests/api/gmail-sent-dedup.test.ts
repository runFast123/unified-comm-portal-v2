// Integration test: POST /api/webhooks/gmail-sent — outbound dedup convergence.
//
// The Gmail-sent webhook (Gmail push → Apps Script) and the IMAP Sent-folder
// reconcile (the poller) both observe the same outbound reply. They MUST key
// dedup on the SAME identifier — the RFC 5322 Message-ID stored in
// `email_message_id`, which backs the partial unique index — or the reply is
// stored twice (the reported bug). These tests lock in:
//   * the webhook stores the NORMALIZED RFC Message-ID in email_message_id,
//   * it dedups on email_message_id when an rfc_message_id is present,
//   * a row already written by the reconcile is recognized as a duplicate,
//   * a 23505 unique-index race is treated as a duplicate (not a 500),
//   * back-compat: payloads with no rfc_message_id keep the legacy
//     teams_message_id dedup and leave email_message_id null.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

import type { MockSupabase, MockCall } from '../helpers/mock-supabase'
import { createMockSupabase } from '../helpers/mock-supabase'

// The route awaits createServiceRoleClient() once — hand back the per-test mock.
const mockBox: { current: MockSupabase | null } = { current: null }
vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(async () => mockBox.current?.client),
  createServerSupabaseClient: vi.fn(async () => mockBox.current?.client),
}))

// Import AFTER the mock.
import { POST } from '@/app/api/webhooks/gmail-sent/route'

const ORIGINAL_SECRET = process.env.WEBHOOK_SECRET

function makeRequest(body: Record<string, unknown>, opts?: { secret?: string | null }): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const secret = opts?.secret === undefined ? 'test-secret' : opts.secret
  if (secret !== null) headers['x-webhook-secret'] = secret
  return new Request('http://localhost/api/webhooks/gmail-sent', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

const hasFilter = (filters: MockCall['filters'], col: string) =>
  !!filters?.some((f) => f.col === col)

/**
 * Mock where accounts resolve by gmail_address, the conversation lookup
 * (the only messages-select keyed on email_thread_id) returns conv-1, the
 * dedup lookup returns `dedupHit`, and the message insert returns `insertError`
 * (or a fresh row on success).
 */
function buildMock(
  opts: {
    dedupHit?: { id: string } | null
    insertError?: { code?: string; message?: string } | null
  } = {},
) {
  const dedupHit = opts.dedupHit ?? null
  const insertError = opts.insertError ?? null
  return createMockSupabase({
    handlers: {
      accounts: {
        onSelect: () => ({ data: { id: 'acc-1', name: 'Acct' }, error: null }),
      },
      messages: {
        onSelect: (filters) => {
          // Conversation lookup is the only select keyed on the thread id;
          // every other select is a dedup probe.
          if (hasFilter(filters, 'email_thread_id')) {
            return { data: { conversation_id: 'conv-1' }, error: null }
          }
          return { data: dedupHit, error: null }
        },
        onInsert: () =>
          insertError
            ? { data: null, error: insertError }
            : { data: { id: 'msg-new' }, error: null },
      },
    },
  })
}

const basePayload = {
  sender: 'Agent <agent@acme.com>',
  to: 'customer@example.com',
  subject: 'Re: Help',
  body: '<p>Sure, here is the answer.</p>',
  thread_id: 'thread-1',
  message_id: 'gmail-internal-18c4abc', // Gmail INTERNAL id (message.getId())
  from_address: 'agent@acme.com',
  sent_at: '2026-05-01T10:00:00.000Z',
}

beforeEach(() => {
  process.env.WEBHOOK_SECRET = 'test-secret'
  mockBox.current = null
})

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.WEBHOOK_SECRET
  else process.env.WEBHOOK_SECRET = ORIGINAL_SECRET
})

describe('POST /api/webhooks/gmail-sent — outbound dedup convergence', () => {
  it('new reply with rfc_message_id: stores NORMALIZED email_message_id + keeps teams_message_id, 201', async () => {
    mockBox.current = buildMock()
    const res = await POST(makeRequest({ ...basePayload, rfc_message_id: '<CADxyz@mail.gmail.com>' }))
    expect(res.status).toBe(201)

    const inserts = mockBox.current!.insertsFor('messages') as Record<string, unknown>[]
    expect(inserts).toHaveLength(1)
    const row = inserts[0]
    // Convergence point: brackets stripped, byte-identical to the poller's normalize.
    expect(row.email_message_id).toBe('CADxyz@mail.gmail.com')
    // Gmail internal id retained for back-compat dedup.
    expect(row.teams_message_id).toBe('gmail-internal-18c4abc')
    expect(row.direction).toBe('outbound')
    expect(row.conversation_id).toBe('conv-1')
  })

  it('dedup probe for an rfc payload keys on email_message_id (normalized), not teams_message_id', async () => {
    mockBox.current = buildMock()
    await POST(makeRequest({ ...basePayload, rfc_message_id: '<CADxyz@mail.gmail.com>' }))
    const selects = mockBox.current!.calls.filter((c) => c.table === 'messages' && c.op === 'select')
    const dedup = selects.find((c) => hasFilter(c.filters, 'email_message_id'))
    expect(dedup).toBeTruthy()
    expect(dedup!.filters!.find((f) => f.col === 'email_message_id')!.value).toBe('CADxyz@mail.gmail.com')
    // It must NOT also fall through to the legacy teams_message_id dedup.
    expect(selects.some((c) => hasFilter(c.filters, 'teams_message_id'))).toBe(false)
  })

  it('reply already written by the IMAP reconcile (same email_message_id): 200 duplicate, no insert', async () => {
    mockBox.current = buildMock({ dedupHit: { id: 'msg-from-reconcile' } })
    const res = await POST(makeRequest({ ...basePayload, rfc_message_id: '<CADxyz@mail.gmail.com>' }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).status).toBe('duplicate')
    expect(mockBox.current!.insertsFor('messages')).toHaveLength(0)
  })

  it('23505 unique-index race with the reconcile: 200 duplicate, not 500', async () => {
    mockBox.current = buildMock({ insertError: { code: '23505', message: 'duplicate key value' } })
    const res = await POST(makeRequest({ ...basePayload, rfc_message_id: '<CADxyz@mail.gmail.com>' }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).status).toBe('duplicate')
  })

  it('back-compat: no rfc_message_id → dedup on teams_message_id, email_message_id stays null', async () => {
    mockBox.current = buildMock()
    const res = await POST(makeRequest({ ...basePayload }))
    expect(res.status).toBe(201)

    const selects = mockBox.current!.calls.filter((c) => c.table === 'messages' && c.op === 'select')
    expect(selects.some((c) => hasFilter(c.filters, 'teams_message_id'))).toBe(true)
    expect(selects.some((c) => hasFilter(c.filters, 'email_message_id'))).toBe(false)

    const row = (mockBox.current!.insertsFor('messages') as Record<string, unknown>[])[0]
    expect(row.email_message_id).toBeNull()
    expect(row.teams_message_id).toBe('gmail-internal-18c4abc')
  })

  it('back-compat: no rfc_message_id, teams_message_id already present → 200 duplicate', async () => {
    mockBox.current = buildMock({ dedupHit: { id: 'msg-existing' } })
    const res = await POST(makeRequest({ ...basePayload }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).status).toBe('duplicate')
    expect(mockBox.current!.insertsFor('messages')).toHaveLength(0)
  })
})
