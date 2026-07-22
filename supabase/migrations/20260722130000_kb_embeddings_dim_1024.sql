-- ============================================================================
-- Resize kb_embeddings.embedding from vector(1536) to vector(1024).
--
-- WHY
--   The RAG embeddings layer was hardcoded to OpenAI text-embedding-3-small
--   (1536 dims), but OPENAI_API_KEY was never set, so vector search has never
--   run. src/lib/embeddings.ts is now provider-configurable and defaults to
--   reusing the existing NVIDIA NIM key (AI_API_KEY) with nv-embedqa-e5-v5,
--   which outputs 1024-dim vectors. The pgvector column has to match the active
--   model's dimension exactly, so it moves to vector(1024).
--
-- SAFE: kb_embeddings has 0 rows (embeddings have never been generated), so the
--   type change and index rebuild are instant and lose nothing. Re-run
--   /api/kb/reindex afterwards to populate embeddings with the new model.
--
-- The HNSW index is dimension-bound, so it must be dropped before the column
-- type change and recreated after. The match_kb_chunks() function takes an
-- untyped `vector` parameter, so it needs no change.
-- ============================================================================

DROP INDEX IF EXISTS public.idx_kb_embeddings_vec;

ALTER TABLE public.kb_embeddings
  ALTER COLUMN embedding TYPE vector(1024) USING embedding::vector(1024);

CREATE INDEX IF NOT EXISTS idx_kb_embeddings_vec
  ON public.kb_embeddings USING hnsw (embedding vector_cosine_ops);

COMMENT ON COLUMN public.kb_embeddings.embedding IS
  'RAG embedding. Dimension MUST match the active provider in src/lib/embeddings.ts (currently 1024 for NVIDIA nv-embedqa-e5-v5). Changing the model to a different size means re-running this resize + /api/kb/reindex.';
