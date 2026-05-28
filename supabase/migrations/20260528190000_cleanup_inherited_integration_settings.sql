-- ============================================================================
-- One-off cleanup: remove integration_settings rows that were cloned to every
-- company during the 20260528170000 per-company migration.
--
-- That migration's backfill copied the existing global Google/Azure OAuth
-- client rows to EVERY company so existing OAuth refresh tokens wouldn't
-- break. The unintended consequence: all companies showed up as
-- "Configured in portal" even when only one had actually set the creds.
-- Per user feedback, that defeats the purpose of per-tenant isolation —
-- new tenants should start unconfigured.
--
-- Strategy: keep integration_settings rows ONLY for companies that have at
-- least one channel_configs row depending on the OAuth client (i.e., have
-- active OAuth-connected accounts whose refresh tokens were minted against
-- the current client). Other companies' rows are deleted; they can set up
-- their own Google/Azure clients via the /admin/integrations UI.
--
-- Safety guard: only run when the buggy state is detectable (rows older
-- than the bug-fix cutoff). If any integration_settings row was created or
-- updated AFTER 2026-05-28 19:00 UTC (when this cleanup shipped), assume
-- a tenant has since configured their own OAuth client legitimately and
-- DO NOT purge anything — that would silently delete real user config on
-- a migration replay (CI rebuild, dev DB recreate, branch reset).
-- ============================================================================

DO $$
DECLARE
  newer_row_count int;
BEGIN
  SELECT count(*) INTO newer_row_count
  FROM public.integration_settings
  WHERE updated_at > '2026-05-28 19:00:00+00';

  IF newer_row_count > 0 THEN
    RAISE NOTICE
      'cleanup_inherited_integration_settings: % row(s) newer than 2026-05-28 19:00 UTC found — skipping cleanup to avoid purging legitimate post-fix configs.',
      newer_row_count;
    RETURN;
  END IF;

  DELETE FROM public.integration_settings
  WHERE company_id NOT IN (
    SELECT DISTINCT a.company_id
    FROM public.channel_configs cc
    JOIN public.accounts a ON a.id = cc.account_id
    WHERE a.company_id IS NOT NULL
  );
END $$;
