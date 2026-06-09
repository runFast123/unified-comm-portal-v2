-- Realtime push for live chat: broadcast livechat message inserts + agent-typing
-- to a per-session channel (lcw:<session_id>) via Supabase Realtime Broadcast, so
-- the widget gets instant updates over a WebSocket (polling stays as a fallback).
-- Every realtime.send is wrapped so a broadcast failure can NEVER roll back the
-- underlying write. Channel is checked first → near-zero cost for non-livechat.

CREATE OR REPLACE FUNCTION public.livechat_broadcast_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE sess text;
BEGIN
  IF NEW.channel = 'livechat' THEN
    SELECT c.teams_chat_id INTO sess FROM public.conversations c WHERE c.id = NEW.conversation_id;
    IF sess IS NOT NULL THEN
      BEGIN
        PERFORM realtime.send(
          jsonb_build_object('id', NEW.id, 'direction', NEW.direction, 'text', NEW.message_text, 'sender_name', NEW.sender_name, 'at', NEW.timestamp),
          'message', 'lcw:' || sess, false);
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS livechat_broadcast_message_trg ON public.messages;
CREATE TRIGGER livechat_broadcast_message_trg
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.livechat_broadcast_message();

CREATE OR REPLACE FUNCTION public.livechat_broadcast_typing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.channel = 'livechat' AND NEW.teams_chat_id IS NOT NULL
     AND NEW.agent_typing_at IS NOT NULL
     AND NEW.agent_typing_at IS DISTINCT FROM OLD.agent_typing_at THEN
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('typing', true),
        'typing', 'lcw:' || NEW.teams_chat_id, false);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS livechat_broadcast_typing_trg ON public.conversations;
CREATE TRIGGER livechat_broadcast_typing_trg
  AFTER UPDATE OF agent_typing_at ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.livechat_broadcast_typing();
