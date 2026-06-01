-- ============================================================================
-- KB-grounded AI (RAG) — pgvector embedding store for kb_articles.
--
-- Adds a per-chunk embedding table + a cosine-similarity match RPC so the AI
-- pipeline can retrieve the most relevant Knowledge Base passages for a given
-- customer message (vector search), instead of (or alongside) the existing
-- keyword scoring in /api/ai-reply.
--
-- Provider: OpenAI `text-embedding-3-small` (1536 dims). Embeddings are written
-- ONLY via the service-role client (the /api/kb/reindex route); there is no
-- user-facing write path, so this table has a SELECT policy but deliberately no
-- INSERT/UPDATE/DELETE policy (those are service-role, which bypasses RLS).
--
-- ── TENANCY MODEL ──────────────────────────────────────────────────────────
-- Every chunk carries `company_id` (the tenant key), copied from its parent
-- `kb_articles.company_id` at index time. Two independent guards enforce the
-- tenant boundary:
--
--   1. RLS SELECT policy (user-context reads): mirrors the kb_articles policy —
--          is_super_admin() OR company_id = current_user_company_id()
--      Both helpers key off auth.uid(); on the service-role client auth.uid() is
--      NULL, so a user-context read can never see another tenant's chunks.
--
--   2. match_kb_chunks(... p_company_id ...) is SECURITY DEFINER and is invoked
--      by the AI pipeline on the SERVICE-ROLE client (where RLS/auth.uid() give
--      no scope). It is therefore NOT auth.uid()-scoped — the tenant boundary is
--      the explicit `WHERE company_id = p_company_id` predicate. The caller
--      (kb-retrieval.ts) passes the company it ALREADY resolved from a verified
--      account, exactly as the existing ai-reply path resolves company before
--      reading kb_articles. Passing the company explicitly (rather than relying
--      on auth.uid()) is what lets the same RPC serve the service-role pipeline
--      safely. Callers MUST pass a trusted, server-resolved company_id — never a
--      value taken straight from a request body.
--
-- ON DELETE CASCADE on kb_article_id keeps embeddings in lockstep with their
-- article: deleting/deactivating + reindexing an article replaces its rows.
--
-- Idempotent: CREATE EXTENSION / TABLE / INDEX ... IF NOT EXISTS +
-- CREATE OR REPLACE FUNCTION. Safe to re-run.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Embedding store ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kb_embeddings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_article_id uuid REFERENCES public.kb_articles(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL,
  chunk_index   int NOT NULL DEFAULT 0,
  content       text NOT NULL,
  embedding     vector(1536),
  created_at    timestamptz DEFAULT now()
);

-- Approximate-nearest-neighbour index for cosine distance (<=>). HNSW gives
-- fast recall without a training step; vector_cosine_ops matches the `<=>`
-- operator used by match_kb_chunks.
CREATE INDEX IF NOT EXISTS idx_kb_embeddings_vec
  ON public.kb_embeddings
  USING hnsw (embedding vector_cosine_ops);

-- Tenant-scope + per-article filters (the reindex route deletes by article;
-- the match RPC filters by company).
CREATE INDEX IF NOT EXISTS idx_kb_embeddings_company
  ON public.kb_embeddings (company_id);

CREATE INDEX IF NOT EXISTS idx_kb_embeddings_article
  ON public.kb_embeddings (kb_article_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.kb_embeddings ENABLE ROW LEVEL SECURITY;

-- SELECT only, mirroring kb_articles. No INSERT/UPDATE/DELETE policy: all writes
-- go through the service-role client (which bypasses RLS) in /api/kb/reindex.
DROP POLICY IF EXISTS "Read kb_embeddings in own company" ON public.kb_embeddings;
CREATE POLICY "Read kb_embeddings in own company" ON public.kb_embeddings
  FOR SELECT USING (
    is_super_admin() OR company_id = current_user_company_id()
  );

-- ── Cosine-similarity match RPC ─────────────────────────────────────────────
-- Returns the p_match_count nearest chunks within p_company_id, ordered by
-- cosine distance. similarity = 1 - cosine_distance (1.0 = identical direction,
-- 0.0 = orthogonal). SECURITY DEFINER + pinned search_path so it runs
-- consistently on the service-role client; the tenant boundary is the explicit
-- company_id filter (see TENANCY MODEL above).
CREATE OR REPLACE FUNCTION public.match_kb_chunks(
  p_query_embedding vector(1536),
  p_company_id uuid,
  p_match_count int DEFAULT 4
)
RETURNS TABLE (kb_article_id uuid, content text, similarity real)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.kb_article_id,
    e.content,
    (1 - (e.embedding <=> p_query_embedding))::real AS similarity
  FROM public.kb_embeddings e
  WHERE e.company_id = p_company_id
    AND e.embedding IS NOT NULL
  ORDER BY e.embedding <=> p_query_embedding
  LIMIT GREATEST(coalesce(p_match_count, 4), 1);
$$;

-- The AI pipeline calls this on the service-role client (service_role); the
-- user-context dashboard may also call it for the caller's own company
-- (authenticated). anon/PUBLIC get nothing.
GRANT EXECUTE ON FUNCTION public.match_kb_chunks(vector(1536), uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_kb_chunks(vector(1536), uuid, int) TO service_role;
REVOKE EXECUTE ON FUNCTION public.match_kb_chunks(vector(1536), uuid, int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.match_kb_chunks(vector(1536), uuid, int) FROM PUBLIC;
