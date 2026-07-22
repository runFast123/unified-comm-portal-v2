// ─── Embeddings for RAG — provider-configurable, OpenAI-compatible ──────────
//
// Thin, dependency-free wrapper around any OpenAI-compatible `/embeddings`
// endpoint (OpenAI, NVIDIA NIM, Jina, Together, Mistral, …), used by the
// KB-grounded AI (RAG) pipeline. Calls the HTTP API via `fetch` — no npm dep.
//
// PROVIDER RESOLUTION (first match wins) — see resolveEmbeddingConfig():
//   1. EMBEDDINGS_API_KEY (+ _BASE_URL / _MODEL / _DIM / _INPUT_TYPE) — explicit,
//      any provider. This is the escape hatch: point it anywhere.
//   2. OPENAI_API_KEY — legacy default (text-embedding-3-small, 1536 dims).
//   3. AI_API_KEY on an NVIDIA base (AI_BASE_URL) — REUSE the chat provider's
//      key for embeddings, so a deployment already using NVIDIA NIM for chat gets
//      vector search with no separate key or signup. Model nv-embedqa-e5-v5
//      (1024 dims).
//
// GRACEFUL DEGRADATION IS THE WHOLE POINT: when nothing is configured (or any
// request fails) every function returns null instead of throwing, so the
// keyword-based retrieval keeps working and RAG simply becomes a no-op. NOTHING
// here ever throws.
//
// DIMENSION MUST MATCH THE DB: `kb_embeddings.embedding` is a fixed-size
// pgvector column. The active provider's output dimension has to equal it
// (currently vector(1024) for nv-embedqa-e5-v5). Changing the model to a
// different size means: resize the column + its HNSW index, then re-run
// /api/kb/reindex. A mismatch degrades to "no vector results" (the pgvector
// distance op errors → retrieveKbContext catches → keyword fallback), never a
// crash.

import { logWarn } from '@/lib/logger'

const EMBEDDING_TIMEOUT_MS = 20_000

const stripTrailingSlash = (b: string) => b.replace(/\/+$/, '')
const isNvidiaBase = (b: string) => /nvidia\.com/i.test(b)

export interface EmbeddingConfig {
  /** Full endpoint, e.g. https://integrate.api.nvidia.com/v1/embeddings */
  url: string
  apiKey: string
  model: string
  /** Output vector length — MUST equal the kb_embeddings column dimension. */
  dimensions: number
  /**
   * When true, send `input_type: query|passage` on each request. NVIDIA NeMo
   * Retriever (nv-embedqa) is an asymmetric model and REQUIRES it; symmetric
   * models (OpenAI) don't accept it, so it's only sent when this is set.
   */
  asymmetric: boolean
}

/**
 * Resolve the active embedding provider from env, or null when none is
 * configured. Pure (reads env only) so callers can gate cheaply.
 */
export function resolveEmbeddingConfig(): EmbeddingConfig | null {
  const env = process.env

  // 1. Explicit embeddings provider — any OpenAI-compatible endpoint.
  const explicitKey = env.EMBEDDINGS_API_KEY?.trim()
  if (explicitKey) {
    const base = stripTrailingSlash(env.EMBEDDINGS_BASE_URL?.trim() || 'https://api.openai.com/v1')
    return {
      url: `${base}/embeddings`,
      apiKey: explicitKey,
      model: env.EMBEDDINGS_MODEL?.trim() || 'text-embedding-3-small',
      dimensions: Number(env.EMBEDDINGS_DIM) || 1536,
      // Opt in explicitly, or infer for an NVIDIA base.
      asymmetric: env.EMBEDDINGS_INPUT_TYPE === '1' || isNvidiaBase(base),
    }
  }

  // 2. Legacy OpenAI — unchanged behaviour for existing deployments.
  const openaiKey = env.OPENAI_API_KEY?.trim()
  if (openaiKey) {
    return {
      url: 'https://api.openai.com/v1/embeddings',
      apiKey: openaiKey,
      model: 'text-embedding-3-small',
      dimensions: 1536,
      asymmetric: false,
    }
  }

  // 3. Reuse the NVIDIA chat key for embeddings — no separate key needed. Only
  //    for an NVIDIA base, since not every OpenAI-compatible chat endpoint
  //    serves /embeddings.
  const aiKey = env.AI_API_KEY?.trim()
  const aiBase = env.AI_BASE_URL?.trim()
  if (aiKey && aiBase && isNvidiaBase(aiBase)) {
    return {
      url: `${stripTrailingSlash(aiBase)}/embeddings`,
      apiKey: aiKey,
      model: env.EMBEDDINGS_MODEL?.trim() || 'nvidia/nv-embedqa-e5-v5',
      dimensions: Number(env.EMBEDDINGS_DIM) || 1024,
      asymmetric: true,
    }
  }

  return null
}

/**
 * True iff an embedding provider is configured. Callers gate on this to skip the
 * RAG path entirely when it's a no-op.
 */
export function isEmbeddingEnabled(): boolean {
  return resolveEmbeddingConfig() !== null
}

/** The active provider's output dimension (falls back to 1536 when disabled). */
export function embeddingDimensions(): number {
  return resolveEmbeddingConfig()?.dimensions ?? 1536
}

/**
 * Low-level: POST a batch of inputs and return vectors aligned to input order,
 * or null (whole batch) when disabled or on ANY error — never throws.
 *
 * `kind` drives input_type for asymmetric models: 'query' for a search query,
 * 'passage' for a document being indexed. Ignored by symmetric providers.
 *
 * The provider's `data` array isn't guaranteed ordered, so we re-sort by `index`
 * before mapping back.
 */
async function requestEmbeddings(
  inputs: string[],
  kind: 'query' | 'passage'
): Promise<number[][] | null> {
  const cfg = resolveEmbeddingConfig()
  if (!cfg) return null
  if (inputs.length === 0) return []

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS)
  try {
    const body: Record<string, unknown> = { model: cfg.model, input: inputs }
    if (cfg.asymmetric) {
      // Required by NVIDIA NeMo Retriever; `truncate` guards a chunk that
      // exceeds the model's token limit rather than erroring the whole request.
      body.input_type = kind
      body.truncate = 'END'
      body.encoding_format = 'float'
    }

    const response = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      logWarn('ai', 'embedding_request_failed', `embeddings ${response.status}`, {
        status: response.status,
        model: cfg.model,
        body: body.slice(0, 200),
      })
      return null
    }

    const json = (await response.json()) as {
      data?: Array<{ index?: number; embedding?: number[] }>
    }
    const data = json.data
    if (!Array.isArray(data) || data.length === 0) {
      logWarn('ai', 'embedding_empty_response', 'embeddings returned no data', { model: cfg.model })
      return null
    }

    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const vectors = ordered.map((d) => d.embedding)
    if (vectors.some((v) => !Array.isArray(v) || v.length === 0)) {
      logWarn('ai', 'embedding_malformed_vector', 'embeddings missing a vector', { model: cfg.model })
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
 * Embed a single string. `kind` defaults to 'query' since the common single-use
 * is embedding a search query. Returns the vector, or null when disabled or the
 * request fails. Never throws.
 */
export async function embed(
  text: string,
  kind: 'query' | 'passage' = 'query'
): Promise<number[] | null> {
  const input = (text ?? '').toString()
  if (input.trim().length === 0) return null
  const vectors = await requestEmbeddings([input], kind)
  if (!vectors || vectors.length === 0) return null
  return vectors[0] ?? null
}

/**
 * Embed many strings in one request. `kind` defaults to 'passage' since the
 * batch use is indexing documents. Returns an array aligned to `texts` where
 * each element is its vector or null. Never throws.
 */
export async function embedBatch(
  texts: string[],
  kind: 'query' | 'passage' = 'passage'
): Promise<(number[] | null)[]> {
  if (!Array.isArray(texts) || texts.length === 0) return []
  const vectors = await requestEmbeddings(
    texts.map((t) => (t ?? '').toString()),
    kind
  )
  if (!vectors) return texts.map(() => null)
  return texts.map((_, i) => vectors[i] ?? null)
}
