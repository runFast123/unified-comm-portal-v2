// Tests POST /api/ai-compose — the Smart Compose ghost-text endpoint.
//
// Coverage:
//   * 401 when unauthenticated
//   * 429 when the per-user rate limit fires (UI silently backs off)
//   * 404 when the conversation isn't found
//   * 403 when the user lacks access to the account
//   * 200 happy path returns a sanitized continuation string + uses the
//     last 5 messages for context
//   * 200 + skipped:true on AIBudgetExceededError (NEVER 500)
//   * 200 + suggestion:'' when AI throws a non-budget error
//
// Like the ai-summarize tests we mock supabase + callAI so nothing hits
// the network or DB.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- Mocks ---------------------------------------------------------

const { callAIMock, rateLimitMock, verifyAccessMock } = vi.hoisted(() => ({
  callAIMock: vi.fn<(...args: any[]) => Promise<string>>(async () => 'sure thing!'),
  rateLimitMock: vi.fn<(...args: any[]) => Promise<boolean>>(async () => true),
  verifyAccessMock: vi.fn<(...args: any[]) => Promise<boolean>>(async () => true),
}))

vi.mock('@/lib/api-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-helpers')>(
    '@/lib/api-helpers',
  )
  return {
    ...actual,
    callAI: callAIMock,
    verifyAccountAccess: verifyAccessMock,
    checkRateLimit: rateLimitMock,
  }
})

// Mutable supabase fixtures.
const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  conversation: { id: 'conv-1', account_id: 'acc-1' } as
    | { id: string; account_id: string }
    | null,
  messageRows: [
    { sender_name: 'Alice', direction: 'inbound', message_text: 'I need help with my invoice', timestamp: '2026-04-30T10:00:00Z' },
    { sender_name: 'Bob', direction: 'outbound', message_text: 'Sure, can you share the invoice number?', timestamp: '2026-04-30T10:01:00Z' },
    { sender_name: 'Alice', direction: 'inbound', message_text: 'INV-9912', timestamp: '2026-04-30T10:02:00Z' },
  ] as Array<Record<string, any>>,
  // Last `messages` query that landed on this fixture — captured for
  // context-assembly assertions.
  lastMessagesLimit: null as number | null,
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      const chain: any = {
        select: (_cols?: string) => chain,
        eq: () => chain,
        order: () => chain,
        limit: (n: number) => {
          if (table === 'messages') fixture.lastMessagesLimit = n
          return chain
        },
        maybeSingle: async () => {
          if (table === 'conversations') {
            return { data: fixture.conversation, error: null }
          }
          return { data: null, error: null }
        },
        then: (resolve: any) => {
          if (table === 'messages') {
            resolve({ data: fixture.messageRows, error: null })
          } else {
            resolve({ data: null, error: null })
          }
        },
      }
      return chain
    },
  }
}

function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: fixture.user }, error: null }),
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

vi.mock('@/lib/logger', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}))

// ---- Import the route AFTER mocks ---------------------------------
import { POST } from '@/app/api/ai-compose/route'
import { AIBudgetExceededError } from '@/lib/ai-usage'

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/ai-compose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/ai-compose', () => {
  beforeEach(() => {
    callAIMock.mockClear()
    callAIMock.mockResolvedValue('sure thing!')
    rateLimitMock.mockClear()
    rateLimitMock.mockResolvedValue(true)
    verifyAccessMock.mockClear()
    verifyAccessMock.mockResolvedValue(true)
    fixture.user = { id: 'user-1' }
    fixture.conversation = { id: 'conv-1', account_id: 'acc-1' }
    fixture.lastMessagesLimit = null
  })

  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await POST(
      makeRequest({ conversation_id: 'conv-1', current_text: 'Hello' }),
    )
    expect(res.status).toBe(401)
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it('429 when the per-user rate limit fires', async () => {
    rateLimitMock.mockResolvedValueOnce(false)
    const res = await POST(
      makeRequest({ conversation_id: 'conv-1', current_text: 'Hello' }),
    )
    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.skipped).toBe(true)
    // We never reach the AI provider when rate-limited.
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it('400 when conversation_id is missing', async () => {
    const res = await POST(makeRequest({ current_text: 'Hello' }))
    expect(res.status).toBe(400)
  })

  it('200 with empty suggestion when current_text is empty', async () => {
    const res = await POST(
      makeRequest({ conversation_id: 'conv-1', current_text: '' }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.suggestion).toBe('')
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it('404 when the conversation is not found', async () => {
    fixture.conversation = null
    const res = await POST(
      makeRequest({ conversation_id: 'conv-missing', current_text: 'Hello' }),
    )
    expect(res.status).toBe(404)
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it('403 when the user lacks access to the conversation account', async () => {
    verifyAccessMock.mockResolvedValueOnce(false)
    const res = await POST(
      makeRequest({ conversation_id: 'conv-1', current_text: 'Hello' }),
    )
    expect(res.status).toBe(403)
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it('200 happy path: returns a sanitized continuation + pulls last 5 messages', async () => {
    callAIMock.mockResolvedValueOnce('  let me look into that for you.  ')
    const res = await POST(
      makeRequest({ conversation_id: 'conv-1', current_text: 'Sure,' }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(typeof json.suggestion).toBe('string')
    // A leading space is added because "Sure," doesn't end in whitespace and
    // the suggestion doesn't begin with punctuation.
    expect(json.suggestion).toBe(' let me look into that for you.')
    // Context window cap = 5 messages.
    expect(fixture.lastMessagesLimit).toBe(5)
    // Charged to the conversation's account_id with the right endpoint name.
    expect(callAIMock).toHaveBeenCalledTimes(1)
    const ctx = callAIMock.mock.calls[0][2]
    expect(ctx).toMatchObject({ account_id: 'acc-1', endpoint: 'ai-compose' })
  })

  it('200 + skipped:true when AIBudgetExceededError is thrown (never 500)', async () => {
    callAIMock.mockRejectedValueOnce(
      new AIBudgetExceededError('acc-1', 51.23, 50),
    )
    const res = await POST(
      makeRequest({ conversation_id: 'conv-1', current_text: 'Hi there' }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.skipped).toBe(true)
    expect(json.suggestion).toBeNull()
  })

  it('200 + empty suggestion on a generic AI failure (soft-fail, never 500)', async () => {
    callAIMock.mockRejectedValueOnce(new Error('upstream blew up'))
    const res = await POST(
      makeRequest({ conversation_id: 'conv-1', current_text: 'Hello' }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.suggestion).toBe('')
  })

  it('strips an echoed prefix and surrounding quotes', async () => {
    callAIMock.mockResolvedValueOnce('"Hello world, how can I help?"')
    const res = await POST(
      makeRequest({ conversation_id: 'conv-1', current_text: 'Hello' }),
    )
    const json = await res.json()
    // Echo of "Hello" is stripped, leaving the continuation. A leading
    // space is added because the typed text doesn't end in whitespace.
    expect(json.suggestion).toBe(' world, how can I help?')
  })
})
