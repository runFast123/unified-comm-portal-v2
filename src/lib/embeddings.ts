// ─── OpenAI embeddings (text-embedding-3-small, 1536 dims) ──────────────────
//
// Thin, dependency-free wrapper around the OpenAI embeddings REST endpoint,
// used by the KB-grounded AI (RAG) pipeline. We call the HTTP API via `fetch`
// rather than the openai SDK so this adds NO npm dependency.
//
// GRACEFUL DEGRADATION IS THE WHOLE POINT:
//   `OPENAI_API_KEY` may not be set in a given deployment. When it is absent
//   (or any request fails) every function here returns null instead of
//   throwing, so the existing keyword-based AI keeps working unchanged and the
//   RAG layer simply becomes a no-op. NOTHING in this module ever throws.
//
// The provider/model/dimension are fixed to match the pgvector column
// (`kb_embeddings.embedding vector(1536)`); changing the model means a
// re-embed + a column change.

import { logWarn } from '@/lib/logger'

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'
const EMBEDDING_MODEL = 'text-embedding-3-small'
/** Dimensions of text-embedding-3-small — must match kb_embeddings.embedding vector(1536). */
export const EMBEDDING_DIMENSIONS = 1536
/** Abort the upstream call if OpenAI hangs, so a slow embed never stalls the AI flow. */
const EMBEDDING_TIMEOUT_MS = 20_000

/**
 * True iff embeddings are configured (OPENAI_API_KEY is set + non-empty).
 * Callers gate on this to skip the RAG path entirely when it's a no-op.
 */
export function isEmbeddingEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0
}

/**
 * Low-level: POST a batch of input strings to OpenAI and return the parsed
 * embedding vectors aligned to the input order. Returns null (the whole batch)
 * when disabled or on ANY error — never throws. Empty input → []  (no call).
 *
 * OpenAI returns `data: [{ index, embedding: number[] }, ...]`; the array is
 * not guaranteed ordered, so we re-sort by `index` before mapping back.
 */
async function requestEmbeddings(inputs: string[]): Promise<number[][] | null> {
  if (!isEmbeddingEnabled()) return null
  if (inputs.length === 0) return []

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS)
  try {
    const response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      logWarn('ai', 'embedding_request_failed', `OpenAI embeddings ${response.status}`, {
        status: response.status,
        body: body.slice(0, 200),
      })
      return null
    }

    const json = (await response.json()) as {
      data?: Array<{ index?: number; embedding?: number[] }>
    }
    const data = json.data
    if (!Array.isArray(data) || data.length === 0) {
      logWarn('ai', 'embedding_empty_response', 'OpenAI embeddings returned no data', {})
      return null
    }

    // Re-order by `index` so vectors line up with the input array, then validate
    // each is a non-empty numeric vector.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const vectors = ordered.map((d) => d.embedding)
    if (vectors.some((v) => !Array.isArray(v) || v.length === 0)) {
      logWarn('ai', 'embedding_malformed_vector', 'OpenAI embeddings missing a vector', {})
      return null
    }
    return vectors as number[][]
  } catch (err) {
    // Includes AbortError (timeout) and network failures. Soft-fail to null.
    logWarn('ai', 'embedding_request_error', err instanceof Error ? err.message : 'unknown error', {})
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Embed a single string. Returns a 1536-dim vector, or null when embeddings are
 * disabled or the request fails. Never throws.
 */
export async function embed(text: string): Promise<number[] | null> {
  const input = (text ?? '').toString()
  if (input.trim().length === 0) return null
  const vectors = await requestEmbeddings([input])
  if (!vectors || vectors.length === 0) return null
  return vectors[0] ?? null
}

/**
 * Embed many strings in one request. Returns an array aligned to `texts` where
 * each element is its vector or null. When the whole batch fails (disabled or
 * request error) every element is null, so callers can map 1:1 without special
 * casing. Never throws.
 */
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (!Array.isArray(texts) || texts.length === 0) return []
  const vectors = await requestEmbeddings(texts.map((t) => (t ?? '').toString()))
  if (!vectors) return texts.map(() => null)
  // Defensive: align lengths even if the provider returned a short array.
  return texts.map((_, i) => vectors[i] ?? null)
}
