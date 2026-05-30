-- ============================================================================
-- Knowledge Base → proper multi-tenant (company) scoping.
--
-- Before: kb_articles was keyed on account_id only, with no company_id. The UI
-- mislabeled the account picker as "Company", and account_id IS NULL meant
-- "shared across ALL companies" — a cross-tenant leak (the AI, on the
-- service-role client, pulled every company's null-account articles), while the
-- SELECT RLS didn't even grant null-account reads to company_admins (so it was
-- broken in the UI too).
--
-- After: every article belongs to a COMPANY (company_id, the tenant key).
-- account_id stays optional and now NARROWS within the company:
--   - account_id IS NULL  → applies to the whole company (all its accounts)
--   - account_id set       → applies to that one account (must be in company_id)
-- There is NO cross-company sharing.
--
-- The table is empty today, so this is a clean-slate change (the backfill is a
-- no-op but kept for safety / re-runs).
-- ============================================================================

ALTER TABLE public.kb_articles
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE;

-- Derive company_id from the article's account (no-op on an empty table).
UPDATE public.kb_articles k
   SET company_id = a.company_id
  FROM public.accounts a
 WHERE k.account_id = a.id AND k.company_id IS NULL;

-- company_id is REQUIRED going forward (no cross-company "global" tier). Only
-- promote to NOT NULL if nothing is left unassigned, so the migration is safe
-- even if a legacy null-account/null-company row somehow exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.kb_articles WHERE company_id IS NULL) THEN
    ALTER TABLE public.kb_articles ALTER COLUMN company_id SET NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kb_articles_company ON public.kb_articles (company_id);

-- Consistency guard: when account_id is set it MUST belong to company_id, so a
-- client can never bind an article to another tenant's account.
CREATE OR REPLACE FUNCTION public.kb_articles_validate_account_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.account_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.accounts a
       WHERE a.id = NEW.account_id AND a.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'kb_articles.account_id % does not belong to company_id %',
        NEW.account_id, NEW.company_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kb_articles_validate ON public.kb_articles;
CREATE TRIGGER trg_kb_articles_validate
  BEFORE INSERT OR UPDATE ON public.kb_articles
  FOR EACH ROW EXECUTE FUNCTION public.kb_articles_validate_account_company();

-- Replace the account-scoped RLS with COMPANY-scoped policies.
DROP POLICY IF EXISTS "Read kb_articles in own company" ON public.kb_articles;
DROP POLICY IF EXISTS "Admins manage kb_articles in scope" ON public.kb_articles;
DROP POLICY IF EXISTS "Admins manage kb_articles in company" ON public.kb_articles;

CREATE POLICY "Read kb_articles in own company" ON public.kb_articles
  FOR SELECT USING (
    is_super_admin() OR company_id = current_user_company_id()
  );

CREATE POLICY "Admins manage kb_articles in company" ON public.kb_articles
  FOR ALL USING (
    is_super_admin() OR (is_company_admin() AND company_id = current_user_company_id())
  )
  WITH CHECK (
    is_super_admin() OR (is_company_admin() AND company_id = current_user_company_id())
  );
