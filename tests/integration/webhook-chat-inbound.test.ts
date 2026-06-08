// Integration test: POST /api/webhooks/{telegram,messenger,instagram}
//
// Regression guard for the bug where these inbound chat webhooks inserted
// `teams_chat_id` into `messages` — a column that lives only on
// `conversations`. Postgres rejected the insert (error 42703), so inbound
// messages on these channels failed to store (HTTP 500 "Failed to store
// message").
//
// The mock's `messages.onInsert` faithfully simulates Postgres: it returns the
// 42703 error if the insert payload still carries `teams_chat_id`. So each test
// FAILS (500) against the old code and PASSES (201) against the fix. We also
// assert the chat id still lands on the `conversations` row (via
// findOrCreateConversation), which is where it belongs.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// `after()` from next/server fires the AI dispatches — spy so we can assert it.
vi.mock('next/server', async (importActual) => {
  const actual = await importActual<typeof import('next/server')>()
  return { ...actual, after: vi.fn() }
})

// next/headers — getRequestId() calls headers(), which throws outside a request.
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

// Rate limiter — allow by default; preserve the rest of api-helpers so
// validateWebhookSecret / findOrCreateConversation / getAccountSettings run for real.
const { rateLimitAllowed } = vi.hoisted(() => ({ rateLimitAllowed: { v: true } }))
vi.mock('@/lib/api-helpers', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api-helpers')>()
  return {
    ...actual,
    checkRateLimit: vi.fn(async () => rateLimitAllowed.v),
  }
})

// Notification fan-out — dynamically imported by the routes; stub it out.
vi.mock('@/lib/notification-service', () => ({
  triggerNotifications: vi.fn(async () => undefined),
}))

// Routing engine — keep deterministic: nothing matches, nothing applied.
vi.mock('@/lib/routing-engine', () => ({
  evaluateRouting: vi.fn(async () => ({ matched_rule_ids: [] })),
  applyRoutingResult: vi.fn(async () => undefined),
}))

import type { MockSupabase } from '../helpers/mock-supabase'
import { createMockSupabase } from '../helpers/mock-supabase'

const mockBox: { current: MockSupabase | null } = { current: null }
vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(async () => mockBox.current?.client),
  createServerSupabaseClient: vi.fn(async () => mockBox.current?.client),
}))

// Import AFTER mocks.
import { after } from 'next/server'
import { POST as telegramPOST } from '@/app/api/webhooks/telegram/route'
import { POST as messengerPOST } from '@/app/api/webhooks/messenger/route'
import { POST as instagramPOST } from '@/app/api/webhooks/instagram/route'

const ORIGINAL_SECRET = process.env.WEBHOOK_SECRET

function makeRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'test-secret' },
    body: JSON.stringify(body),
  })
}

/**
 * Mock Supabase whose `messages` insert rejects the phantom `teams_chat_id`
 * column exactly as Postgres does (error 42703 / "column ... does not exist").
 */
function buildMock() {
  const accountRow = {
    id: 'acc-1',
    name: 'Test Account',
    is_active: true,
    phase1_enabled: true,
    phase2_enabled: true,
    settings: {},
  }
  return createMockSupabase({
    handlers: {
      accounts: {
        // Used for the id/active check AND getAccountSettings (.select('*')).
        onSelect: () => ({ data: accountRow, error: null }),
      },
      conversations: {
        // No existing conversation → insert path returns a fresh id.
        onSelect: () => ({ data: null, error: null }),
        onInsert: () => ({ data: { id: 'conv-new-1' }, error: null }),
      },
      messages: {
        // No dedup hit.
        onSelect: () => ({ data: null, error: null }),
        onInsert: (payload) => {
          const row = (payload ?? {}) as Record<string, unknown>
          if ('teams_chat_id' in row) {
            return {
              data: null,
              error: {
                code: '42703',
                message: 'column "teams_chat_id" of relation "messages" does not exist',
              },
            }
          }
          return { data: { id: 'msg-new-1', ...row }, error: null }
        },
      },
    },
  })
}

const CHANNELS = [
  {
    channel: 'telegram',
    POST: telegramPOST,
    url: 'http://localhost/api/webhooks/telegram',
    body: { account_id: 'acc-1', chat_id: '987654321', sender_name: 'Tg User', text: 'hi from telegram', message_id: '42' },
    chatId: '987654321',
  },
  {
    channel: 'messenger',
    POST: messengerPOST,
    url: 'http://localhost/api/webhooks/messenger',
    body: { account_id: 'acc-1', sender_id: 'psid-999', sender_name: 'Fb User', text: 'hi from messenger', message_id: 'mid.aaa' },
    chatId: 'psid-999',
  },
  {
    channel: 'instagram',
    POST: instagramPOST,
    url: 'http://localhost/api/webhooks/instagram',
    body: { account_id: 'acc-1', sender_id: 'igsid-777', sender_name: 'Ig User', text: 'hi from instagram', message_id: 'mid.bbb' },
    chatId: 'igsid-777',
  },
] as const

beforeEach(() => {
  vi.mocked(after).mockClear()
  rateLimitAllowed.v = true
  process.env.WEBHOOK_SECRET = 'test-secret'
})

describe.each(CHANNELS)('POST /api/webhooks/$channel — inbound store', ({ channel, POST, url, body, chatId }) => {
  it('stores the message WITHOUT teams_chat_id (only conversations has it) → 201', async () => {
    mockBox.current = buildMock()
    const res = await POST(makeRequest(url, body))

    // Old code: insert carried teams_chat_id → mock returns 42703 → 500.
    expect(res.status).toBe(201)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.message_id).toBe('msg-new-1')
    expect(json.conversation_id).toBe('conv-new-1')

    // The messages insert must NOT carry teams_chat_id.
    const msgInserts = mockBox.current!.insertsFor('messages')
    expect(msgInserts).toHaveLength(1)
    const msg = msgInserts[0] as Record<string, unknown>
    expect(msg).not.toHaveProperty('teams_chat_id')
    expect(msg.channel).toBe(channel)
    expect(msg.conversation_id).toBe('conv-new-1')
    expect(msg.teams_message_id).toBe(String(body.message_id))

    // The chat id still lands on the conversation row.
    const convInserts = mockBox.current!.insertsFor('conversations')
    expect(convInserts).toHaveLength(1)
    expect((convInserts[0] as Record<string, unknown>).teams_chat_id).toBe(chatId)

    // Full happy path: both AI phases dispatched via after().
    expect(vi.mocked(after)).toHaveBeenCalledTimes(2)
  })
})

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.WEBHOOK_SECRET
  else process.env.WEBHOOK_SECRET = ORIGINAL_SECRET
})
