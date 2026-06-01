// Tests for src/lib/kb-retrieval.ts — vector retrieval over kb_embeddings.
//
// Covers:
//   * disabled (no OPENAI_API_KEY) → { enabled: false, chunks: [] }, and the
//     RPC / service-role client are NEVER touched
//   * enabled happy path → embeds the query, calls match_kb_chunks with the
//     server-resolved company_id, and returns the mapped chunks
//   * empty query short-circuits (enabled, no embed, no RPC)
//   * soft failures (embed returns null, RPC errors) → enabled:true, empty —
//     never throws
//
// `@/lib/embeddings` and `@/lib/supabase-server` are mocked via vi.hoisted so
// the route never makes a real OpenAI/Supabase call.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

const fixture = vi.hoisted(() => ({
  enabled: true,
  embedResult: null as number[] | null,
  rpcRows: [] as Array<{ kb_article_id: string; content: string; similarity: number }>,
  rpcError: null as { message: string } | null,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  serviceRoleConstructed: 0,
}))

vi.mock('@/lib/embeddings', () => ({
  isEmbeddingEnabled: vi.fn(() => fixture.enabled),
  embed: vi.fn(async () => fixture.embedResult),
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(async () => {
    fixture.serviceRoleConstructed += 1
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        fixture.rpcCalls.push({ fn, args })
        if (fixture.rpcError) return { data: null, error: fixture.rpcError }
        return { data: fixture.rpcRows, error: null }
      },
    }
  }),
}))

import { retrieveKbContext } from '@/lib/kb-retrieval'

beforeEach(() => {
  fixture.enabled = true
  fixture.embedResult = Array.from({ length: 1536 }, () => 0.01)
  fixture.rpcRows = []
  fixture.rpcError = null
  fixture.rpcCalls = []
  fixture.serviceRoleConstructed = 0
})

describe('retrieveKbContext — disabled', () => {
  it('returns enabled:false and never touches the RPC/service-role client', async () => {
    fixture.enabled = false
    const result = await retrieveKbContext('what are your rates?', 'company-1')
    expect(result).toEqual({ enabled: false, chunks: [] })
    expect(fixture.serviceRoleConstructed).toBe(0)
    expect(fixture.rpcCalls).toHaveLength(0)
  })
})

describe('retrieveKbContext — enabled happy path', () => {
  it('embeds the query, calls match_kb_chunks with company_id, returns chunks', async () => {
    fixture.rpcRows = [
      { kb_article_id: 'art-1', content: 'Our A-Z routes start at $0.005/min.', similarity: 0.91 },
      { kb_article_id: 'art-2', content: 'SMS is billed per segment.', similarity: 0.77 },
    ]
    const result = await retrieveKbContext('how much are your routes', 'company-42', 2)

    expect(result.enabled).toBe(true)
    expect(result.chunks).toHaveLength(2)
    expect(result.chunks[0]).toEqual({
      kb_article_id: 'art-1',
      content: 'Our A-Z routes start at $0.005/min.',
      similarity: 0.91,
    })

    // RPC invoked once with the resolved company + the embedded query vector.
    expect(fixture.rpcCalls).toHaveLength(1)
    expect(fixture.rpcCalls[0].fn).toBe('match_kb_chunks')
    expect(fixture.rpcCalls[0].args.p_company_id).toBe('company-42')
    expect(fixture.rpcCalls[0].args.p_match_count).toBe(2)
    expect(Array.isArray(fixture.rpcCalls[0].args.p_query_embedding)).toBe(true)
    expect((fixture.rpcCalls[0].args.p_query_embedding as number[]).length).toBe(1536)
  })

  it('defaults to k=4 when not supplied', async () => {
    await retrieveKbContext('hello', 'company-1')
    expect(fixture.rpcCalls[0].args.p_match_count).toBe(4)
  })

  it('coerces similarity to a number', async () => {
    fixture.rpcRows = [
      { kb_article_id: 'a', content: 'c', similarity: '0.5' as unknown as number },
    ]
    const result = await retrieveKbContext('q', 'company-1')
    expect(result.chunks[0].similarity).toBe(0.5)
  })
})

describe('retrieveKbContext — short-circuit + soft failures', () => {
  it('empty query: enabled, no embed call, no RPC', async () => {
    const result = await retrieveKbContext('   ', 'company-1')
    expect(result).toEqual({ enabled: true, chunks: [] })
    expect(fixture.rpcCalls).toHaveLength(0)
  })

  it('missing companyId: enabled, no RPC', async () => {
    const result = await retrieveKbContext('real query', '')
    expect(result).toEqual({ enabled: true, chunks: [] })
    expect(fixture.rpcCalls).toHaveLength(0)
  })

  it('embed soft-failed (null) → enabled, empty, no RPC', async () => {
    fixture.embedResult = null
    const result = await retrieveKbContext('real query', 'company-1')
    expect(result).toEqual({ enabled: true, chunks: [] })
    expect(fixture.rpcCalls).toHaveLength(0)
  })

  it('RPC error → enabled, empty (never throws)', async () => {
    fixture.rpcError = { message: 'function match_kb_chunks does not exist' }
    const result = await retrieveKbContext('real query', 'company-1')
    expect(result).toEqual({ enabled: true, chunks: [] })
    expect(fixture.rpcCalls).toHaveLength(1)
  })
})
