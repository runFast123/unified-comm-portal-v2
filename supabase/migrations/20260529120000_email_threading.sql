-- Industry-standard email threading (Gmail/Front style).
--
-- BEFORE: email conversations were keyed off the SENDER address. Two redundant
-- UNIQUE partial indexes enforced one-conversation-per-sender:
--   * uniq_conversations_email_participant  (account_id, lower(participant_email))
--   * uniq_conversations_email_thread       (account_id, channel, participant_email)
-- That collapsed every distinct RFC thread from a given sender into a single
-- conversation (197 real threads → 51 conversations in prod).
--
-- AFTER: emails are grouped by a stable THREAD ROOT (first id in the RFC
-- References chain / In-Reply-To / own Message-ID, or a Gmail threadId when
-- available). `conversations.email_thread_id` stores that root; the message's
-- own Message-ID is stored in `messages.email_message_id`.
--
-- GO-FORWARD ONLY. This migration intentionally does NOT re-thread or split the
-- 974 historical messages / 51 existing conversations — backfilling the
-- existing rows onto the new key is a SEPARATE, explicitly-scoped step. New
-- inbound mail threads correctly from here on.

-- ── 1. New columns ──────────────────────────────────────────────────
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS email_thread_id text;
ALTER TABLE public.messages      ADD COLUMN IF NOT EXISTS email_message_id text;

-- ── 2. Lookup index on the new thread key ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_conversations_email_thread
  ON public.conversations (account_id, email_thread_id)
  WHERE email_thread_id IS NOT NULL;

-- ── 3. Drop the sender-uniqueness indexes ───────────────────────────
-- Both of these enforced one-conversation-per-sender on email and MUST go so
-- multiple threads per sender are allowed. Verified live via:
--   SELECT indexname, indexdef FROM pg_indexes WHERE tablename='conversations';
-- `uniq_conversations_email_thread` is also dropped here because its current
-- definition is sender-based — it is RECREATED below with the new semantics
-- (keyed on email_thread_id).
DROP INDEX IF EXISTS public.uniq_conversations_email_participant;
DROP INDEX IF EXISTS public.uniq_conversations_email_thread;

-- ── 4. Non-unique fallback lookup on participant_email ──────────────
-- The legacy/last-resort matching path in findOrCreateConversation still looks
-- up by (account_id, participant_email) when no thread id is available. Keep a
-- plain (non-unique) index so that path stays fast without re-introducing the
-- one-conversation-per-sender constraint.
CREATE INDEX IF NOT EXISTS idx_conversations_email_participant
  ON public.conversations (account_id, participant_email)
  WHERE channel = 'email' AND participant_email IS NOT NULL;

-- ── 5. Race-safety UNIQUE index on the new key ──────────────────────
-- Two concurrent ingests of the same thread must not create duplicate
-- conversations. A unique-violation (23505) here is caught by the race-recovery
-- re-select in findOrCreateConversation, which then returns the winning row.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversations_email_thread
  ON public.conversations (account_id, email_thread_id)
  WHERE channel = 'email' AND email_thread_id IS NOT NULL;
