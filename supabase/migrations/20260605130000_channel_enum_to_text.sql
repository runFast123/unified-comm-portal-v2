-- Increment 3 (Phase 0): convert the channel_type enum columns to text so a NEW
-- channel needs only an app-level registry entry -- no DB migration.
--
-- Validated via a BEGIN...ROLLBACK dry-run on prod before applying. 0 functions /
-- views / RLS policies depend on channel_type; the only enum-literal
-- dependencies are 5 partial indexes (dropped + recreated below with text
-- predicates). Every other channel index auto-rebuilds during ALTER. The
-- channel_type enum type itself is intentionally LEFT in place (unused) so this
-- stays reversible. No CHECK constraint is added -- that would re-introduce a
-- per-channel migration, defeating the purpose. Matches pending_sends.channel,
-- which was already text. App is unaffected: src/types/database.ts hand-defines
-- ChannelType as a controlled union, so channel stays validated in TS.

-- 1) Drop the 5 partial indexes whose predicates embed channel = 'x'::channel_type.
DROP INDEX IF EXISTS public.idx_conversations_email_participant;
DROP INDEX IF EXISTS public.uniq_conversations_email_thread;
DROP INDEX IF EXISTS public.uniq_conversations_whatsapp_phone;
DROP INDEX IF EXISTS public.uniq_conversations_whatsapp_participant;
DROP INDEX IF EXISTS public.uniq_messages_account_email_message_id;

-- 2) Convert every channel_type column to text.
ALTER TABLE public.accounts           ALTER COLUMN channel_type TYPE text USING channel_type::text;
ALTER TABLE public.ai_replies         ALTER COLUMN channel      TYPE text USING channel::text;
ALTER TABLE public.channel_configs    ALTER COLUMN channel      TYPE text USING channel::text;
ALTER TABLE public.conversations      ALTER COLUMN channel      TYPE text USING channel::text;
ALTER TABLE public.messages           ALTER COLUMN channel      TYPE text USING channel::text;
ALTER TABLE public.notification_rules ALTER COLUMN channel      TYPE text USING channel::text;
ALTER TABLE public.scheduled_messages ALTER COLUMN channel      TYPE text USING channel::text;

-- 3) Recreate the 5 partial indexes with text predicates (identical otherwise).
CREATE INDEX idx_conversations_email_participant
  ON public.conversations USING btree (account_id, participant_email)
  WHERE ((channel = 'email') AND (participant_email IS NOT NULL));
CREATE UNIQUE INDEX uniq_conversations_email_thread
  ON public.conversations USING btree (account_id, email_thread_id)
  WHERE ((channel = 'email') AND (email_thread_id IS NOT NULL));
CREATE UNIQUE INDEX uniq_conversations_whatsapp_phone
  ON public.conversations USING btree (account_id, channel, participant_phone)
  WHERE ((channel = 'whatsapp') AND (participant_phone IS NOT NULL));
CREATE UNIQUE INDEX uniq_conversations_whatsapp_participant
  ON public.conversations USING btree (account_id, participant_phone)
  WHERE ((channel = 'whatsapp') AND (participant_phone IS NOT NULL));
CREATE UNIQUE INDEX uniq_messages_account_email_message_id
  ON public.messages USING btree (account_id, email_message_id)
  WHERE ((email_message_id IS NOT NULL) AND (channel = 'email'));
