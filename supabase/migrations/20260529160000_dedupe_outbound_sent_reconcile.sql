-- ============================================================================
-- Clean up duplicate OUTBOUND email messages created by the Sent-folder
-- reconcile in the email poller.
--
-- Symptom: one conversation (Dave Jones / djones@crexendo.com) showed 328
-- messages — 1 inbound, 327 identical "Agent (via Gmail)" outbound copies of
-- the same reply.
--
-- Root cause: the Sent-folder reconcile deduped against a now()-relative
-- 2-hour window on `received_at`. But `received_at` stores the email's Date
-- header (not insert time), so once a sent reply aged past 2 hours the window
-- never matched again and every 2-minute poll re-inserted it (~one per cycle).
-- The rows also had no email_message_id, so the partial unique index couldn't
-- catch them either.
--
-- The poller now (a) stores the RFC Message-ID on each reconciled Sent row and
-- (b) dedups by (account_id, email_message_id) — time-independent and backed by
-- the existing partial unique index — so a re-fetch is a guaranteed no-op.
--
-- This migration is the one-time backfill cleanup: keep a single outbound row
-- per (conversation_id, body), preferring one that carries a Message-ID, and
-- drop the rest. message_classifications / ai_replies children CASCADE.
-- Idempotent — a no-op on a database with no outbound duplicates.
-- ============================================================================

WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY conversation_id, md5(coalesce(message_text,''))
      ORDER BY (email_message_id IS NOT NULL AND email_message_id <> '') DESC,
               received_at ASC, id ASC
    ) AS rn
  FROM public.messages
  WHERE channel = 'email' AND direction = 'outbound'
)
DELETE FROM public.messages m USING ranked r WHERE m.id = r.id AND r.rn > 1;
