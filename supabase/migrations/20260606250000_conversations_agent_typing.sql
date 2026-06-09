-- Live-chat "agent is typing" signal: the inbox composer pings a timestamp here
-- (throttled), the widget poll surfaces it as agent_typing when recent (<8s).
-- Tiny, livechat-only in practice; service-role writes so RLS is unaffected.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS agent_typing_at timestamptz;
