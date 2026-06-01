// Tests for src/lib/embeddings.ts — the OpenAI embeddings wrapper.
//
// Covers:
//   * isEmbeddingEnabled() reflects OPENAI_API_KEY presence
//   * embed()/embedBatch() return null (no fetch) when disabled
//   * parses a well-formed OpenAI response (and re-orders by `index`)
//   * fails SOFT (returns null) on a non-200, on a malformed body, and on a
//     thrown/aborted fetch — NEVER throws
//
// global.fetch is mocked per-test; the logger is mocked to a no-op so a soft
// failure doesn't try to hit Supabase/Sentry.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

import { isEmbeddingEnabled, embed, embedBatch } from '@/lib/embeddings'

const ORIGINAL_KEY = process.env.OPENAI_API_KEY

function mockFetchOnce(impl: () => Promise<Response> | Response) {
  const fn = vi.fn(impl)
  // @ts-expect-error - assigning a mock onto the global
  global.fetch = fn
  return fn
}

/** Build a fake OpenAI embeddings response. */
function okResponse(data: Array<{ index: number; embedding: number[] }>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
    text: async () => JSON.stringify({ data }),
  } as unknown as Response
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test-key'
  vi.restoreAllMocks()
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY
})

describe('isEmbeddingEnabled', () => {
  it('true when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-abc'
    expect(isEmbeddingEnabled()).toBe(true)
  })

  it('false when OPENAI_API_KEY is unset', () => {
    delete process.env.OPENAI_API_KEY
    expect(isEmbeddingEnabled()).toBe(false)
  })

  it('false when OPENAI_API_KEY is blank/whitespace', () => {
    process.env.OPENAI_API_KEY = '   '
    expect(isEmbeddingEnabled()).toBe(false)
  })
})

describe('embed — disabled path', () => {
  it('returns null and does NOT call fetch when no key', async () => {
    delete process.env.OPENAI_API_KEY
    const fetchMock = mockFetchOnce(() => okResponse([{ index: 0, embedding: [1, 2, 3] }]))
    const result = await embed('hello world')
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null for empty/whitespace text without calling fetch', async () => {
    const fetchMock = mockFetchOnce(() => okResponse([{ index: 0, embedding: [1] }]))
    expect(await embed('   ')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('embed — enabled happy path', () => {
  it('parses the OpenAI response and returns the vector', async () => {
    const vec = Array.from({ length: 1536 }, (_, i) => i / 1536)
    const fetchMock = mockFetchOnce(() => okResponse([{ index: 0, embedding: vec }]))
    const result = await embed('what are your rates?')
    expect(result).toEqual(vec)

    // Called OpenAI with the right model + a bearer auth header.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/embeddings')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('text-embedding-3-small')
    expect(body.input).toEqual(['what are your rates?'])
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-key')
  })
})

describe('embed — soft failures (never throw)', () => {
  it('returns null on a non-200 response', async () => {
    mockFetchOnce(
      () =>
        ({
          ok: false,
          status: 429,
          json: async () => ({}),
          text: async () => 'rate limited',
        }) as unknown as Response
    )
    await expect(embed('x')).resolves.toBeNull()
  })

  it('returns null on a malformed body (no data array)', async () => {
    mockFetchOnce(
      () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ nope: true }),
          text: async () => '{}',
        }) as unknown as Response
    )
    await expect(embed('x')).resolves.toBeNull()
  })

  it('returns null when fetch throws (network/timeout)', async () => {
    mockFetchOnce(() => {
      throw new Error('network down')
    })
    await expect(embed('x')).resolves.toBeNull()
  })
})

describe('embedBatch', () => {
  it('returns [] for an empty array without calling fetch', async () => {
    const fetchMock = mockFetchOnce(() => okResponse([]))
    expect(await embedBatch([])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aligns vectors to input order even when the API returns them out of order', async () => {
    const fetchMock = mockFetchOnce(() =>
      okResponse([
        { index: 1, embedding: [9, 9] },
        { index: 0, embedding: [1, 1] },
      ])
    )
    const result = await embedBatch(['first', 'second'])
    expect(result).toEqual([
      [1, 1],
      [9, 9],
    ])
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).input).toEqual(['first', 'second'])
  })

  it('returns all-null aligned to input on a soft failure (non-200)', async () => {
    mockFetchOnce(
      () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({}),
          text: async () => 'boom',
        }) as unknown as Response
    )
    expect(await embedBatch(['a', 'b', 'c'])).toEqual([null, null, null])
  })

  it('returns all-null when disabled', async () => {
    delete process.env.OPENAI_API_KEY
    const fetchMock = mockFetchOnce(() => okResponse([{ index: 0, embedding: [1] }]))
    expect(await embedBatch(['a', 'b'])).toEqual([null, null])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
