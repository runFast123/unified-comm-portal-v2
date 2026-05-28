-- ============================================================================
-- integration_settings: scope to one row per (key, company) — close
-- cross-tenant OAuth client credential leak.
--
-- Before this migration the table held a single global row per integration
-- key (one google_oauth, one azure_oauth) shared by every tenant. Any
-- super_admin rotating creds at /admin/integrations would rotate the OAuth
-- client used by EVERY company, and there was no per-company isolation —
-- one tenant's misconfiguration would break sign-in for all the others.
--
-- This migration:
--
--   1. Adds `company_id uuid REFERENCES companies(id) ON DELETE CASCADE`.
--   2. Drops the old PRIMARY KEY (key) so we can fan the existing rows out
--      to many per key during backfill.
--   3. Backfills a copy of each existing global row for every company that
--      doesn't yet have one. Each company starts with the SAME encrypted
--      blob as the current global creds — they continue to work for any
--      already-issued OAuth tokens, but can now be rotated independently.
--   4. Deletes the original global (company_id IS NULL) rows so there's no
--      fallback that re-introduces sharing. The clear invariant after this
--      migration: every row MUST have a company_id.
--   5. SETs company_id NOT NULL.
--   6. Adds the composite PRIMARY KEY (key, company_id) so multiple
--      companies can each have their own google_oauth / azure_oauth rows.
--   7. Replaces the super_admin-only RLS policies with per-company scoped
--      ones — company_admin of the matching tenant gets full CRUD, super_admin
--      retains cross-tenant access.
--
-- NOTE on existing OAuth tokens: stored channel_configs.config_data.
-- google_refresh_token (and equivalent for Teams) are tied to the OAuth
-- client_id/secret in the original global row. Because every company
-- starts with the SAME encrypted blob (just per-company copies), those
-- tokens continue to work after this migration. ROTATING a company's
-- creds via /admin/integrations from now on WILL invalidate that
-- company's existing refresh tokens — by design.
--
-- ⚠ KNOWN ISSUE — see 20260528190000_cleanup_inherited_integration_settings:
-- The "clone to every company" backfill below was a footgun: it made every
-- tenant LOOK configured in the UI even when only one had actually set the
-- creds. The follow-up migration deletes orphan clones for companies with
-- no OAuth-dependent channel_configs. Future deploys against an empty DB
-- naturally skip the backfill (no global rows to clone), so this only
-- affected the single migration of an existing production database.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ── 1. Add company_id column ────────────────────────────────────────────────
ALTER TABLE public.integration_settings
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE;

-- ── 2. Drop the old PRIMARY KEY (key) BEFORE backfill ──────────────────────
-- Backfill creates multiple rows per key (one per company); the single-column
-- PK would block that. We re-add the composite PK after the data is shaped.
ALTER TABLE public.integration_settings DROP CONSTRAINT IF EXISTS integration_settings_pkey;

-- ── 3. Backfill: copy each global row for every company ────────────────────
-- For every (existing global row × company) pair where a per-company copy
-- doesn't already exist, INSERT one with the same encrypted payload. New
-- rows preserve last_tested_at/last_tested_ok from the source so we don't
-- pretend untested creds were tested.
INSERT INTO public.integration_settings (
  key,
  config_encrypted,
  updated_at,
  updated_by,
  last_tested_at,
  last_tested_ok,
  company_id
)
SELECT
  src.key,
  src.config_encrypted,
  src.updated_at,
  src.updated_by,
  src.last_tested_at,
  src.last_tested_ok,
  c.id
FROM public.integration_settings src
CROSS JOIN public.companies c
WHERE src.company_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.integration_settings dst
    WHERE dst.key = src.key AND dst.company_id = c.id
  );

-- ── 4. Delete the legacy global rows ────────────────────────────────────────
-- After backfill every company has its own copy, so the unscoped row is
-- both redundant and dangerous (would re-enable the sharing we just
-- broke). Drop it.
DELETE FROM public.integration_settings WHERE company_id IS NULL;

-- ── 5. Lock down: company_id is now mandatory ──────────────────────────────
ALTER TABLE public.integration_settings ALTER COLUMN company_id SET NOT NULL;

-- ── 6. Add the composite PRIMARY KEY (key, company_id) ─────────────────────
ALTER TABLE public.integration_settings
  ADD CONSTRAINT integration_settings_pkey PRIMARY KEY (key, company_id);

-- Lookup index — the PK already covers (key, company_id), but a
-- company-only index helps the admin UI "show all integrations for this
-- tenant" pattern.
CREATE INDEX IF NOT EXISTS integration_settings_company_id_idx
  ON public.integration_settings (company_id);

-- ── 7. RLS policies — restore company_admin access (scoped) ────────────────
-- Drop EVERY existing policy first, then re-create cleanly. We don't know
-- every policy name across deploys, so iterate pg_policy.
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT polname FROM pg_policy WHERE polrelid = 'public.integration_settings'::regclass
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.integration_settings', pol.polname);
  END LOOP;
END$$;

ALTER TABLE public.integration_settings ENABLE ROW LEVEL SECURITY;

-- SELECT: super_admin sees all; company_admin sees their company's rows.
CREATE POLICY "integration_settings select"
  ON public.integration_settings
  FOR SELECT
  TO authenticated
  USING (
    is_super_admin()
    OR (is_company_admin() AND company_id = current_user_company_id())
  );

-- INSERT: same shape — company_admin can only insert rows for their own company.
CREATE POLICY "integration_settings insert"
  ON public.integration_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    is_super_admin()
    OR (is_company_admin() AND company_id = current_user_company_id())
  );

-- UPDATE: same shape.
CREATE POLICY "integration_settings update"
  ON public.integration_settings
  FOR UPDATE
  TO authenticated
  USING (
    is_super_admin()
    OR (is_company_admin() AND company_id = current_user_company_id())
  )
  WITH CHECK (
    is_super_admin()
    OR (is_company_admin() AND company_id = current_user_company_id())
  );

-- DELETE: same shape.
CREATE POLICY "integration_settings delete"
  ON public.integration_settings
  FOR DELETE
  TO authenticated
  USING (
    is_super_admin()
    OR (is_company_admin() AND company_id = current_user_company_id())
  );

COMMENT ON TABLE public.integration_settings IS
  'Per-company OAuth client credentials (Google, Azure). Encrypted via CHANNEL_CONFIG_ENCRYPTION_KEY. Composite PK (key, company_id) — every row is owned by exactly one company.';

COMMENT ON COLUMN public.integration_settings.company_id IS
  'Owning company. Each company configures its OWN Google/Azure OAuth client; rotating one tenant''s creds does not affect any other.';
