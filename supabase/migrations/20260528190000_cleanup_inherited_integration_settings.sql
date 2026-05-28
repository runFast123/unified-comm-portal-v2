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
-- Idempotent: re-running is a no-op (the same DELETE WHERE clause matches
-- zero rows on a clean state).
-- ============================================================================

DELETE FROM public.integration_settings
WHERE company_id NOT IN (
  SELECT DISTINCT a.company_id
  FROM public.channel_configs cc
  JOIN public.accounts a ON a.id = cc.account_id
  WHERE a.company_id IS NOT NULL
);
