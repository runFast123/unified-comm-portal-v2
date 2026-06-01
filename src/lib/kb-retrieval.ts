// ─── KB retrieval (RAG) — vector search over kb_embeddings ──────────────────
//
// The read side of the KB-grounded AI pipeline. Given a customer message and a
// SERVER-RESOLVED company id, it embeds the query and asks pgvector for the
// most similar KB chunks via the `match_kb_chunks` SECURITY DEFINER RPC.
//
// Called from the AI pipeline (ai-reply) on the service-role client. Because
// that client has no auth.uid(), tenant scope is the explicit `p_company_id`
// argument — the SAME company the caller already resolved from a verified
// account (see api/ai-reply resolving `account.company_id`). NEVER pass a
// company id taken straight from a request body.
//
// Degrades gracefully:
//   - embeddings disabled (no OPENAI_API_KEY)  → { enabled: false, chunks: [] }
//   - embed fails / RPC errors / any throw     → { enabled: true,  chunks: [] }
// so the existing keyword-based AI path is never blocked by the RAG layer.
// NEVER throws.

import { createServiceRoleClient } from '@/lib/supabase-server'
import { isEmbeddingEnabled, embed } from '@/lib/embeddings'
import { logWarn } from '@/lib/logger'

export interface KbChunk {
  kb_article_id: string
  content: string
  similarity: number
}

export interface KbRetrievalResult {
  /** False when embeddings are not configured — the caller should fall back to
   *  its non-RAG behaviour. True even when `chunks` is empty (configured but no
   *  match / soft failure). */
  enabled: boolean
  chunks: KbChunk[]
}

/**
 * Retrieve the top-`k` KB chunks most relevant to `query` within `companyId`.
 *
 * @param query     The text to ground against (e.g. the customer's message).
 * @param companyId Server-resolved tenant id. The tenant boundary — do not pass
 *                  untrusted input.
 * @param k         Max chunks to return (default 4).
 */
export async function retrieveKbContext(
  query: string,
  companyId: string,
  k = 4
): Promise<KbRetrievalResult> {
  // Fast no-op when embeddings aren't configured: signal disabled so the caller
  // keeps its existing behaviour.
  if (!isEmbeddingEnabled()) {
    return { enabled: false, chunks: [] }
  }

  // Missing inputs: enabled, but nothing to retrieve.
  if (!query || !query.trim() || !companyId) {
    return { enabled: true, chunks: [] }
  }

  try {
    const queryEmbedding = await embed(query)
    // embed() soft-failed (e.g. transient OpenAI error). Stay enabled, empty.
    if (!queryEmbedding) {
      return { enabled: true, chunks: [] }
    }

    const matchCount = Math.max(1, Math.floor(k) || 4)
    const supabase = await createServiceRoleClient()
    const { data, error } = await supabase.rpc('match_kb_chunks', {
      p_query_embedding: queryEmbedding,
      p_company_id: companyId,
      p_match_count: matchCount,
    })

    if (error) {
      logWarn('ai', 'kb_match_rpc_failed', error.message, { company_id: companyId })
      return { enabled: true, chunks: [] }
    }

    const rows = (data as KbChunk[] | null) ?? []
    const chunks: KbChunk[] = rows.map((r) => ({
      kb_article_id: r.kb_article_id,
      content: r.content,
      similarity: Number(r.similarity) || 0,
    }))
    return { enabled: true, chunks }
  } catch (err) {
    // Belt-and-braces: anything unexpected → empty, never throws.
    logWarn('ai', 'kb_retrieval_error', err instanceof Error ? err.message : 'unknown error', {
      company_id: companyId,
    })
    return { enabled: true, chunks: [] }
  }
}
