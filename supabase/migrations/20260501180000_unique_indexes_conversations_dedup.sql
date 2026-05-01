-- T2: Prevent race-condition duplicate conversations under concurrent ingest.
-- `findOrCreateConversation` looks up by (account_id, channel, participant_X);
-- only `teams_chat_id` had a unique partial index, so email + WhatsApp were
-- race-prone — two concurrent webhooks for the same customer could each
-- decide "no existing conversation, create one" and end up with duplicates.
--
-- Adds case-insensitive unique partial indexes scoped per channel.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversations_email_participant
  ON public.conversations (account_id, lower(participant_email))
  WHERE channel = 'email' AND participant_email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversations_whatsapp_participant
  ON public.conversations (account_id, participant_phone)
  WHERE channel = 'whatsapp' AND participant_phone IS NOT NULL;

-- M2: Webhook subscription atomic-increment RPC.
-- Replaces the read-then-write pattern in src/lib/webhook-dispatcher.ts which
-- under concurrent firings could under-count failures and delay auto-disable.
CREATE OR REPLACE FUNCTION public.increment_webhook_failures(sub_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  new_count integer;
BEGIN
  UPDATE public.webhook_subscriptions
  SET consecutive_failures = consecutive_failures + 1,
      is_active = CASE WHEN consecutive_failures + 1 >= 5 THEN false ELSE is_active END
  WHERE id = sub_id
  RETURNING consecutive_failures INTO new_count;
  RETURN new_count;
END $$;

GRANT EXECUTE ON FUNCTION public.increment_webhook_failures(uuid) TO authenticated, service_role;
