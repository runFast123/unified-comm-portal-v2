-- ============================================================================
-- Auto-Summarize Threads: cache columns on `conversations`.
--
-- Added by the Auto-Summarize Threads feature (Apr 2026). The /api/ai-summarize
-- endpoint stores the generated summary on the conversation row so subsequent
-- page loads do not re-pay AI tokens. Cache is invalidated by comparing the
-- current message count against `ai_summary_message_count` — when the count
-- grows past the cached value, the endpoint regenerates.
--
-- Idempotent (`ADD COLUMN IF NOT EXISTS`) so re-applying the migration is safe.
-- ============================================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_summary text,
  ADD COLUMN IF NOT EXISTS ai_summary_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_summary_message_count integer;

COMMENT ON COLUMN public.conversations.ai_summary IS
  'Cached AI-generated thread summary. Regenerated when message count grows past ai_summary_message_count.';
COMMENT ON COLUMN public.conversations.ai_summary_generated_at IS
  'When the cached ai_summary was last produced.';
COMMENT ON COLUMN public.conversations.ai_summary_message_count IS
  'Message count at the time the cached summary was generated. Cache is invalidated when current messages.count > this.';
