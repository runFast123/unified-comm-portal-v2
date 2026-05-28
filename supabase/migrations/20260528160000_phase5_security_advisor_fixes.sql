-- ============================================================================
-- Post-Phase-4 hotfix: close the 3 security regressions surfaced by Supabase
-- advisors after Phases 3 + 4 shipped:
--
--   1. companies_active view was created without explicit security_invoker,
--      so it defaulted to SECURITY DEFINER, bypassing RLS. Anyone with
--      SELECT on the view could see ALL companies, archived or not, across
--      tenants.
--   2. company-logos bucket had a broad SELECT policy on storage.objects
--      that allowed LIST operations on the entire bucket. Public buckets
--      don't need a SELECT policy for object-URL access — drop it so only
--      direct URLs work, not directory listing.
--   3. seed_company_defaults was granted EXECUTE to the anon role.
--      Server-only function; revoke from anon (keep authenticated for
--      defense in depth — the route still uses service-role).
-- ============================================================================

-- 1) Recreate companies_active as SECURITY INVOKER (Postgres 15+ syntax).
DROP VIEW IF EXISTS public.companies_active;
CREATE VIEW public.companies_active
  WITH (security_invoker = true) AS
  SELECT * FROM public.companies WHERE archived_at IS NULL;
COMMENT ON VIEW public.companies_active IS
  'Active companies (archived_at IS NULL). SECURITY INVOKER — respects RLS of the querying user.';
GRANT SELECT ON public.companies_active TO authenticated;

-- 2) Drop the broad public-read policy on company-logos. Object URLs still
--    work because the bucket is public=true — listing now requires explicit
--    auth (and we don't need to expose listing publicly anyway).
DROP POLICY IF EXISTS "Anyone can read company-logos" ON storage.objects;

-- 3) REVOKE seed_company_defaults from anon. Keep authenticated grant for
--    defense in depth (server uses service_role which bypasses this anyway).
REVOKE EXECUTE ON FUNCTION public.seed_company_defaults(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.seed_company_defaults(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.seed_company_defaults(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.seed_company_defaults(uuid) TO service_role;
