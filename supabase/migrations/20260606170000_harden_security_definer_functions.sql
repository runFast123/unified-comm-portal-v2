-- Security-advisor hardening (NOT a tenancy fix — company isolation was already
-- clean). The two updated_at trigger functions added in the RBAC / AI-model
-- migrations were needlessly SECURITY DEFINER; they only set NEW.updated_at, so
-- SECURITY INVOKER is correct (matches every other touch_* function in the schema)
-- and clears the advisor's "SECURITY DEFINER callable via RPC" flag. CREATE OR
-- REPLACE keeps the same oid, so the existing BEFORE UPDATE triggers keep firing.
CREATE OR REPLACE FUNCTION public.touch_ai_model_assignments_updated_at() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION public.touch_permissions_updated_at() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

-- user_allowed_channels must stay SECURITY DEFINER (it reads the RLS-protected
-- permission tables to resolve a user's channels) and executable by `authenticated`
-- (the channel RLS policies invoke it) — but `anon` never needs it. Drop the stray
-- Supabase-default grant to anon.
REVOKE EXECUTE ON FUNCTION public.user_allowed_channels() FROM anon;
