-- These are TRIGGER functions only; triggers fire regardless of EXECUTE grants.
-- Revoke the PostgREST RPC exposure so anon/authenticated can't call them directly
-- (addresses the anon_security_definer_function_executable advisor warnings).
REVOKE EXECUTE ON FUNCTION public.livechat_broadcast_message() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.livechat_broadcast_typing() FROM anon, authenticated, public;
