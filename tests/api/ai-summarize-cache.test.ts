// Tests the cache behavior of POST /api/ai-summarize:
//   * cache hit when message count hasn't grown past stored count
//   * cache miss + write when message count grew
//   * `force: true` always regenerates
//   * AIBudgetExceededError → 200 with skipped: true and previously-cached
//     summary when one exists
//
// We mock the supabase clients + `callAI` so the route runs end-to-end without
// touching the network or DB.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- Mocks ---------------------------------------------------------

// Hoisted because vi.mock factories run before normal module top-level code.
const { callAIMock } = vi.hoisted(() => ({
  callAIMock: vi.fn<(...args: any[]) => Promise<string>>(async () => 'mock summary text'),
}))

vi.mock('@/lib/api-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-helpers')>(
    '@/lib/api-helpers',
  )
  return {
    ...actual,
    callAI: callAIMock,
    verifyAccountAccess: vi.fn(async () => true),
  }
})

// Mutable fixtures the mocked supabase client reads from.
const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  conversation: {
    id: 'conv-1',
    account_id: 'acc-1',
    ai_summary: null as string | null,
    ai_summary_generated_at: null as string | null,
    ai_summary_message_count: null as number | null,
  },
  liveMessageCount: 5,
  // last update payload captured by the mock so tests can assert what was written
  lastUpdate: null as Record<string, any> | null,
  // recent message rows returned by the second `messages` query
  messageRows: [
    { sender_name: 'Alice', direction: 'inbound', message_text: 'hi', timestamp: '2026-04-30T10:00:00Z' },
    { sender_name: 'Bob', direction: 'outbound', message_text: 'hello', timestamp: '2026-04-30T10:01:00Z' },
  ] as Array<Record<string, any>>,
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      let isCountQuery = false
      const chain: any = {
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.count === 'exact' && opts.head) isCountQuery = true
          return chain
        },
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        update: (payload: Record<string, any>) => {
          if (table === 'conversations') fixture.lastUpdate = payload
          return chain
        },
        maybeSingle: async () => {
          if (table === 'conversations') {
            return { data: fixture.conversation, error: null }
          }
          return { data: null, error: null }
        },
        // Awaiting the chain itself (the messages-list query path) returns
        // an array of message rows.
        then: (resolve: any) => {
          if (isCountQuery && table === 'messages') {
            resolve({ data: null, error: null, count: fixture.liveMessageCount })
          } else if (table === 'messages') {
            resolve({ data: fixture.messageRows, error: null })
          } else if (table === 'conversations') {
            // .update().eq() chain awaited
            resolve({ data: null, error: null })
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

// Stub out structured logger so test runs stay quiet.
vi.mock('@/lib/logger', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}))

// ---- Import the route AFTER mocks ---------------------------------
import { POST } from '@/app/api/ai-summarize/route'
import { AIBudgetExceededError } from '@/lib/ai-usage'

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/ai-summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/ai-summarize — caching', () => {
  beforeEach(() => {
    callAIMock.mockClear()
    callAIMock.mockResolvedValue('mock summary text')
    fixture.user = { id: 'user-1' }
    fixture.conversation = {
      id: 'conv-1',
      account_id: 'acc-1',
      ai_summary: null,
      ai_summary_generated_at: null,
      ai_summary_message_count: null,
    }
    fixture.liveMessageCount = 5
    fixture.lastUpdate = null
  })

  it('rejects when unauthenticated', async () => {
    fixture.user = null
    const res = await POST(makeRequest({ conversation_id: 'conv-1' }))
    expect(res.status).toBe(401)
  })

  it('cache miss: generates a fresh summary AND persists it', async () => {
    const res = await POST(makeRequest({ conversation_id: 'conv-1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary).toBe('mock summary text')
    expect(json.cached).toBe(false)
    expect(callAIMock).toHaveBeenCalledTimes(1)
    expect(fixture.lastUpdate).toMatchObject({
      ai_summary: 'mock summary text',
      ai_summary_message_count: 5,
    })
    expect(typeof fixture.lastUpdate?.ai_summary_generated_at).toBe('string')
  })

  it('cache hit: returns stored summary without calling AI when count unchanged', async () => {
    fixture.conversation.ai_summary = 'previously stored summary'
    fixture.conversation.ai_summary_generated_at = '2026-04-29T08:00:00Z'
    fixture.conversation.ai_summary_message_count = 5
    fixture.liveMessageCount = 5

    const res = await POST(makeRequest({ conversation_id: 'conv-1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary).toBe('previously stored summary')
    expect(json.cached).toBe(true)
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it('cache invalidated when live message count grew past stored count', async () => {
    fixture.conversation.ai_summary = 'stale summary'
    fixture.conversation.ai_summary_message_count = 5
    fixture.liveMessageCount = 7 // 2 new messages since cache was written

    const res = await POST(makeRequest({ conversation_id: 'conv-1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary).toBe('mock summary text')
    expect(json.cached).toBe(false)
    expect(callAIMock).toHaveBeenCalledTimes(1)
    expect(fixture.lastUpdate?.ai_summary_message_count).toBe(7)
  })

  it('force: true always regenerates even when cache is fresh', async () => {
    fixture.conversation.ai_summary = 'cached summary'
    fixture.conversation.ai_summary_message_count = 5
    fixture.liveMessageCount = 5

    const res = await POST(
      makeRequest({ conversation_id: 'conv-1', force: true }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary).toBe('mock summary text')
    expect(json.cached).toBe(false)
    expect(callAIMock).toHaveBeenCalledTimes(1)
  })

  it('AIBudgetExceededError → 200 skipped, returns previously cached summary if present', async () => {
    fixture.conversation.ai_summary = 'older cached summary'
    fixture.conversation.ai_summary_message_count = 5
    fixture.liveMessageCount = 7 // would be a regen, but budget says no
    callAIMock.mockRejectedValueOnce(
      new AIBudgetExceededError('acc-1', 51.23, 50),
    )

    const res = await POST(makeRequest({ conversation_id: 'conv-1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.skipped).toBe(true)
    expect(json.summary).toBe('older cached summary')
    expect(json.budget_usd).toBe(50)
  })

  it('AI call failure (non-budget) → 200 with summary:null + error', async () => {
    callAIMock.mockRejectedValueOnce(new Error('upstream blew up'))
    const res = await POST(makeRequest({ conversation_id: 'conv-1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary).toBeNull()
    expect(json.error).toBe('AI call failed')
  })
})
