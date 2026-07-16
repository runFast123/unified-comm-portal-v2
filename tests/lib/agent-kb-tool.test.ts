// Tests for search_knowledge_base retrieval behaviour (src/lib/ai/tools.ts).
//
// WHY THE FALLBACK EXISTS
// pgvector retrieval is gated on OPENAI_API_KEY, and retrieveKbContext degrades
// SILENTLY to {enabled:false} when it's unset — which is the case in production
// right now. Without a keyword fallback the tool would answer "the knowledge
// base does not cover it" to every question while the KB held the answer, and
// the copilot's prompt tells the model to trust exactly that signal. ai-reply
// already falls back for this reason; a tool blinder than the path it replaces
// is worse than no tool at all.
//
// The `method` field is asserted throughout because "vector search was off" and
// "the KB genuinely has no answer" are indistinguishable to the model, and they
// need completely different fixes.

import { describe, it, expect, beforeEach, vi } from 'vitest'

let vectorEnabled = true
let vectorChunks: { kb_article_id: string; content: string; similarity: number }[] = []
let articles: { id: string; title: string; content: string }[] = []
let lastArticleFilters: Record<string, unknown> = {}

vi.mock('@/lib/api-helpers', () => ({ verifyAccountAccess: vi.fn(async () => true) }))
vi.mock('@/lib/permissions/server', () => ({ userIdCan: vi.fn(async () => true) }))
vi.mock('@/lib/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(async () => {}),
}))
vi.mock('@/lib/kb-retrieval', () => ({
  retrieveKbContext: vi.fn(async () => ({ enabled: vectorEnabled, chunks: vectorChunks })),
}))

import { runTool, toolsFor } from '@/lib/ai/tools'
import type { ToolContext } from '@/lib/ai/tools'

const ALL = toolsFor()

function client() {
  return {
    from() {
      const q: any = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          lastArticleFilters[col] = val
          return q
        },
        limit: async () => ({ data: articles, error: null }),
      }
      return q
    },
  } as any
}

const ctx: ToolContext = {
  userId: 'user-1',
  companyId: 'company-1',
  accountId: 'account-1',
  conversationId: 'conv-1',
  requestId: 'req-1',
  client: client(),
}

async function search(query: string) {
  const res = await runTool('search_knowledge_base', JSON.stringify({ query }), ctx, {
    allowed: ALL,
  })
  expect(res.ok).toBe(true)
  return res.data as { method: string; matches: any[] }
}

beforeEach(() => {
  vectorEnabled = true
  vectorChunks = []
  articles = []
  lastArticleFilters = {}
})

describe('search_knowledge_base retrieval', () => {
  it('uses vector search when it is enabled and returns matches', async () => {
    vectorChunks = [{ kb_article_id: 'a1', content: 'Annual plans refund within 30 days.', similarity: 0.91 }]
    const data = await search('refund policy annual')
    expect(data.method).toBe('vector')
    expect(data.matches[0].article_id).toBe('a1')
    expect(data.matches[0].similarity).toBe(0.91)
  })

  it('falls back to keywords when vector search is DISABLED (no OPENAI_API_KEY)', async () => {
    vectorEnabled = false
    articles = [
      { id: 'a1', title: 'Refund policy', content: 'Annual plans may be refunded within 30 days.' },
      { id: 'a2', title: 'Shipping', content: 'Orders ship in 2 days.' },
    ]
    const data = await search('refund annual')
    // The whole point: the KB has the answer, so the tool must find it even
    // with embeddings switched off.
    expect(data.method).toBe('keyword_vector_disabled')
    expect(data.matches).toHaveLength(1)
    expect(data.matches[0].article_id).toBe('a1')
  })

  it('falls back to keywords when vector search is enabled but finds nothing', async () => {
    vectorEnabled = true
    vectorChunks = []
    articles = [{ id: 'a1', title: 'Refund policy', content: 'Refunds within 30 days.' }]
    const data = await search('refund')
    expect(data.method).toBe('keyword_after_empty_vector')
    expect(data.matches[0].article_id).toBe('a1')
  })

  it('weighs a title match above a body match', async () => {
    vectorEnabled = false
    articles = [
      { id: 'body', title: 'Misc notes', content: 'a passing mention of refund here' },
      { id: 'title', title: 'Refund policy', content: 'unrelated body text' },
    ]
    const data = await search('refund')
    expect(data.matches[0].article_id).toBe('title')
  })

  it('scopes the keyword query to the caller company and to active articles', async () => {
    vectorEnabled = false
    articles = []
    await search('anything')
    expect(lastArticleFilters.company_id).toBe('company-1')
    expect(lastArticleFilters.is_active).toBe(true)
  })

  it('returns no matches (rather than everything) when nothing scores', async () => {
    vectorEnabled = false
    articles = [{ id: 'a1', title: 'Shipping', content: 'Orders ship in 2 days.' }]
    const data = await search('refund')
    expect(data.matches).toEqual([])
  })

  it('ignores very short tokens so stopwords cannot match everything', async () => {
    vectorEnabled = false
    articles = [{ id: 'a1', title: 'Shipping', content: 'Orders ship in 2 days.' }]
    // "is" / "in" / "a" are <= 2 chars and must not score a match on their own.
    const data = await search('is in a')
    expect(data.matches).toEqual([])
  })
})
