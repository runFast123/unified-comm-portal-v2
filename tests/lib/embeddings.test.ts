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

import { isEmbeddingEnabled, embed, embedBatch, resolveEmbeddingConfig } from '@/lib/embeddings'

// Every env var the resolver reads — snapshot + fully control them per test so
// resolution is deterministic regardless of what the shell/CI has set.
const EMBED_ENV = [
  'EMBEDDINGS_API_KEY',
  'EMBEDDINGS_BASE_URL',
  'EMBEDDINGS_MODEL',
  'EMBEDDINGS_DIM',
  'EMBEDDINGS_INPUT_TYPE',
  'OPENAI_API_KEY',
  'AI_API_KEY',
  'AI_BASE_URL',
] as const
const SNAPSHOT: Record<string, string | undefined> = {}

function mockFetchOnce(impl: () => Promise<Response> | Response) {
  const fn = vi.fn(impl)
  // @ts-expect-error - assigning a mock onto the global
  global.fetch = fn
  return fn
}

/** Build a fake OpenAI-compatible embeddings response. */
function okResponse(data: Array<{ index: number; embedding: number[] }>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
    text: async () => JSON.stringify({ data }),
  } as unknown as Response
}

beforeEach(() => {
  for (const k of EMBED_ENV) {
    SNAPSHOT[k] = process.env[k]
    delete process.env[k]
  }
  // Default to the OpenAI path so the existing suite reads as before.
  process.env.OPENAI_API_KEY = 'sk-test-key'
  vi.restoreAllMocks()
})

afterEach(() => {
  for (const k of EMBED_ENV) {
    if (SNAPSHOT[k] === undefined) delete process.env[k]
    else process.env[k] = SNAPSHOT[k]
  }
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

describe('provider resolution', () => {
  it('OpenAI path does NOT send input_type (symmetric model)', async () => {
    const fetchMock = mockFetchOnce(() => okResponse([{ index: 0, embedding: [1, 2] }]))
    await embed('hi', 'query')
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.input_type).toBeUndefined()
  })

  it('reuses AI_API_KEY on an NVIDIA base for embeddings (no separate key)', async () => {
    delete process.env.OPENAI_API_KEY
    process.env.AI_API_KEY = 'nvapi-test'
    process.env.AI_BASE_URL = 'https://integrate.api.nvidia.com/v1'

    expect(isEmbeddingEnabled()).toBe(true)
    const cfg = resolveEmbeddingConfig()!
    expect(cfg.url).toBe('https://integrate.api.nvidia.com/v1/embeddings')
    expect(cfg.model).toBe('nvidia/nv-embedqa-e5-v5')
    expect(cfg.dimensions).toBe(1024)
    expect(cfg.asymmetric).toBe(true)

    const fetchMock = mockFetchOnce(() => okResponse([{ index: 0, embedding: [1, 2, 3] }]))
    await embed('what are your rates?', 'query')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://integrate.api.nvidia.com/v1/embeddings')
    const body = JSON.parse(init.body as string)
    // Asymmetric model → input_type is sent, and reflects the kind.
    expect(body.input_type).toBe('query')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer nvapi-test')
  })

  it('embedBatch defaults to input_type=passage on an asymmetric model', async () => {
    delete process.env.OPENAI_API_KEY
    process.env.AI_API_KEY = 'nvapi-test'
    process.env.AI_BASE_URL = 'https://integrate.api.nvidia.com/v1'
    const fetchMock = mockFetchOnce(() => okResponse([{ index: 0, embedding: [1] }]))
    await embedBatch(['a chunk of a doc'])
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.input_type).toBe('passage')
  })

  it('does NOT reuse AI_API_KEY when the chat base is not NVIDIA', () => {
    delete process.env.OPENAI_API_KEY
    process.env.AI_API_KEY = 'gsk-groq'
    process.env.AI_BASE_URL = 'https://api.groq.com/openai/v1'
    // Not every OpenAI-compatible chat endpoint serves /embeddings — don't assume.
    expect(isEmbeddingEnabled()).toBe(false)
  })

  it('EMBEDDINGS_API_KEY takes priority and points anywhere', () => {
    process.env.OPENAI_API_KEY = 'sk-should-be-ignored'
    process.env.EMBEDDINGS_API_KEY = 'jina-key'
    process.env.EMBEDDINGS_BASE_URL = 'https://api.jina.ai/v1'
    process.env.EMBEDDINGS_MODEL = 'jina-embeddings-v3'
    process.env.EMBEDDINGS_DIM = '768'
    const cfg = resolveEmbeddingConfig()!
    expect(cfg.url).toBe('https://api.jina.ai/v1/embeddings')
    expect(cfg.apiKey).toBe('jina-key')
    expect(cfg.model).toBe('jina-embeddings-v3')
    expect(cfg.dimensions).toBe(768)
  })
})
