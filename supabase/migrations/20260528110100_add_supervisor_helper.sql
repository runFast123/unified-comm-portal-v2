-- ============================================================================
-- is_supervisor() helper — mirrors is_admin() / is_company_admin() shape.
--
-- True for any user whose role is 'supervisor' or above (supervisor,
-- company_admin, super_admin). Use to gate medium-trust ops (assign to
-- others, merge/unmerge, CSAT send, AI-approve) that go beyond
-- agent-level reply but aren't full admin.
--
-- PHASE 1 PREPARATION ONLY — no policy or API route currently calls this
-- function. Phase 2 will wire it into RLS + route handlers.
--
-- Companion to 20260528110000_add_supervisor_role.sql (which added the
-- enum value). Kept as a separate migration because PostgreSQL forbids
-- referencing a newly-added enum value in the same transaction that
-- added it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_supervisor() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN (
        'supervisor'::user_role,
        'company_admin'::user_role,
        'super_admin'::user_role
      )
      AND COALESCE(is_active, true)
  );
$$;

-- Match the privilege envelope of the other helpers: revoke from PUBLIC
-- and anon, grant to authenticated. See 20260504010000 + 20260504020000.
REVOKE EXECUTE ON FUNCTION public.is_supervisor() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_supervisor() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_supervisor() TO authenticated;
