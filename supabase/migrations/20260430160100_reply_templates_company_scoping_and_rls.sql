-- ============================================================================
-- Reply templates: company-scoping, variables, RLS.
-- Idempotent: safe to re-run.
--
-- Adds the columns the templates feature needs (company_id, subject,
-- created_by) and replaces the permissive default RLS with company-scoped
-- policies that mirror the pattern used by other multi-tenant tables.
-- Also recreates the auth helpers (is_super_admin, is_company_admin,
-- current_user_company_id) so this migration is self-contained.
-- ============================================================================

-- 1) Auth helper functions (idempotent CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role::text = 'super_admin'
      AND COALESCE(is_active, true)
  );
$$;

CREATE OR REPLACE FUNCTION public.current_user_company_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT company_id FROM public.users WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_company_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role::text IN ('admin','company_admin','super_admin')
      AND COALESCE(is_active, true)
  );
$$;

-- 2) Extend reply_templates with company scope, subject, creator audit.
ALTER TABLE public.reply_templates
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Backfill: derive company_id from account_id.company_id where set.
UPDATE public.reply_templates rt
   SET company_id = a.company_id
  FROM public.accounts a
 WHERE rt.account_id = a.id
   AND rt.company_id IS NULL
   AND a.company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reply_templates_company
  ON public.reply_templates (company_id);

-- 3) Unique shortcut per company.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reply_templates_shortcut_per_company
  ON public.reply_templates (company_id, shortcut)
  WHERE shortcut IS NOT NULL AND company_id IS NOT NULL;

-- 4) RLS — company members read; admins write.
ALTER TABLE public.reply_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Auth can manage reply_templates" ON public.reply_templates;
DROP POLICY IF EXISTS "Auth can read reply_templates"   ON public.reply_templates;
DROP POLICY IF EXISTS "templates_read"   ON public.reply_templates;
DROP POLICY IF EXISTS "templates_write"  ON public.reply_templates;
DROP POLICY IF EXISTS "templates_update" ON public.reply_templates;
DROP POLICY IF EXISTS "templates_delete" ON public.reply_templates;

CREATE POLICY "templates_read" ON public.reply_templates
  FOR SELECT TO authenticated USING (
    public.is_super_admin()
    OR company_id = public.current_user_company_id()
    OR (
      company_id IS NULL AND (
        account_id IS NULL
        OR account_id IN (
          SELECT id FROM public.accounts
          WHERE company_id = public.current_user_company_id()
        )
      )
    )
  );

CREATE POLICY "templates_write" ON public.reply_templates
  FOR INSERT TO authenticated WITH CHECK (
    public.is_super_admin()
    OR (
      public.is_company_admin()
      AND (
        company_id = public.current_user_company_id()
        OR (
          company_id IS NULL AND (
            account_id IS NULL
            OR account_id IN (
              SELECT id FROM public.accounts
              WHERE company_id = public.current_user_company_id()
            )
          )
        )
      )
    )
  );

CREATE POLICY "templates_update" ON public.reply_templates
  FOR UPDATE TO authenticated USING (
    public.is_super_admin()
    OR (
      public.is_company_admin()
      AND (
        company_id = public.current_user_company_id()
        OR (
          company_id IS NULL AND (
            account_id IS NULL
            OR account_id IN (
              SELECT id FROM public.accounts
              WHERE company_id = public.current_user_company_id()
            )
          )
        )
      )
    )
  ) WITH CHECK (
    public.is_super_admin()
    OR (
      public.is_company_admin()
      AND (
        company_id = public.current_user_company_id()
        OR (
          company_id IS NULL AND (
            account_id IS NULL
            OR account_id IN (
              SELECT id FROM public.accounts
              WHERE company_id = public.current_user_company_id()
            )
          )
        )
      )
    )
  );

CREATE POLICY "templates_delete" ON public.reply_templates
  FOR DELETE TO authenticated USING (
    public.is_super_admin()
    OR (
      public.is_company_admin()
      AND (
        company_id = public.current_user_company_id()
        OR (
          company_id IS NULL AND (
            account_id IS NULL
            OR account_id IN (
              SELECT id FROM public.accounts
              WHERE company_id = public.current_user_company_id()
            )
          )
        )
      )
    )
  );

-- 5) Atomic usage-count increment used by the composer.
CREATE OR REPLACE FUNCTION public.increment_template_usage_count(template_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public AS $$
  UPDATE public.reply_templates
     SET usage_count = COALESCE(usage_count, 0) + 1,
         updated_at = now()
   WHERE id = template_id;
$$;
