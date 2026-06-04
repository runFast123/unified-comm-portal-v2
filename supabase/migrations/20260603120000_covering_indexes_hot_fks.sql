-- Covering indexes for the foreign keys that participate in hot-path lookups /
-- joins (flagged unindexed by the Supabase performance advisor). We index only
-- the FKs actually used as query predicates at runtime; the remaining audit-only
-- *_created_by / *_updated_by FKs are intentionally left unindexed because their
-- write cost outweighs any read benefit (they are never filter/join columns).
CREATE INDEX IF NOT EXISTS idx_pending_sends_conversation_id ON public.pending_sends (conversation_id);
CREATE INDEX IF NOT EXISTS idx_pending_sends_account_id ON public.pending_sends (account_id);
CREATE INDEX IF NOT EXISTS idx_note_mentions_conversation_id ON public.note_mentions (conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_notes_author_id ON public.conversation_notes (author_id);
CREATE INDEX IF NOT EXISTS idx_conversations_snoozed_by ON public.conversations (snoozed_by);
