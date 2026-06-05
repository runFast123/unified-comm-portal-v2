-- Race-protection unique index for chat-id channels (teams / telegram /
-- messenger / instagram), which group conversations by teams_chat_id. Without
-- it, two concurrent inbound webhooks for the same chat can create duplicate
-- conversations (findOrCreateConversation's app-layer lookup has a race window;
-- its 23505 recovery path in CHANNEL_UNIQUE_KEY assumed this index existed).
-- Channel-partitioned so different channels sharing a chat_id value never
-- collide. Email + WhatsApp already have their own unique indexes. Verified 0
-- existing duplicates before creating. Applied live via the Supabase migration
-- tool; this file mirrors it for repo / fresh-env parity.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversations_chat
  ON public.conversations (account_id, channel, teams_chat_id)
  WHERE teams_chat_id IS NOT NULL;
