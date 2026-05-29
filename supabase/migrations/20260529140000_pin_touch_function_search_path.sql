-- ============================================================================
-- Pin search_path on the two updated_at trigger functions added this session.
--
-- The Supabase linter (0011_function_search_path_mutable) flags functions whose
-- search_path is role-mutable, because a caller could prepend a schema and
-- shadow an unqualified object reference. Both functions here only run
-- `NEW.updated_at := now(); RETURN NEW;` — `now()` resolves from pg_catalog,
-- which is always implicitly in scope — so an empty search_path is safe and
-- closes the warning. Idempotent (ALTER ... SET is repeatable).
-- ============================================================================

ALTER FUNCTION public.touch_reply_templates_updated_at() SET search_path = '';
ALTER FUNCTION public.touch_user_invitations_updated_at() SET search_path = '';
