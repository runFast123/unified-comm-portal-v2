-- ============================================================================
-- Email duplicate cleanup + hard dedup backstop.
--
-- Symptom: the portal showed ~974 emails when the real Gmail had ~200 — an
-- ~5x inflation. Root cause: the email ingest dedup only looked back 5 minutes
-- by `timestamp`, and `idempotency_key` was never set. When the IMAP UID cursor
-- re-scanned the mailbox (re-auth / breaker reset / backfill re-run), it
-- re-ingested every message; the 5-minute window never caught the older copies,
-- so duplicates piled up (784 dup rows across 143 content-identical groups).
--
-- This migration runs ATOMICALLY (single transaction) so the every-2-min poller
-- cannot insert a fresh duplicate between the cleanup and the index — that race
-- is what kept failing standalone index creation.
--
--   1. De-dupe: keep the earliest row per (account_id, email_message_id), or,
--      for the rare pre-fix rows with no Message-ID, per
--      (account, sender, subject, body-hash). FK CASCADE removes the dups'
--      message_classifications + ai_replies; conversations are untouched.
--   2. Drop email conversations left empty by the cleanup.
--   3. Install a partial UNIQUE index on (account_id, email_message_id) for
--      email rows that carry a Message-ID — so the same RFC Message-ID can
--      never be stored twice again, no matter how often the cursor re-scans.
--
-- On a fresh database steps 1–2 are no-ops; step 3 is the durable schema.
-- Idempotent.
-- ============================================================================

WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY account_id,
        CASE WHEN email_message_id IS NOT NULL AND email_message_id <> ''
             THEN 'mid:'||email_message_id
             ELSE 'body:'||coalesce(sender_name,'')||'|'||coalesce(email_subject,'')||'|'||md5(coalesce(message_text,'')) END
      ORDER BY received_at ASC, id ASC
    ) AS rn
  FROM public.messages
  WHERE channel='email'
)
DELETE FROM public.messages m USING ranked r WHERE m.id = r.id AND r.rn > 1;

DELETE FROM public.conversations c
WHERE c.channel='email'
  AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = c.id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_account_email_message_id
  ON public.messages (account_id, email_message_id)
  WHERE email_message_id IS NOT NULL AND channel = 'email';
