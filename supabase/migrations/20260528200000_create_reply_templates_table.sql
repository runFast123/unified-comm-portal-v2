-- ============================================================================
-- reply_templates: create the base table that 20260430160100 assumed existed.
--
-- Discovered via user report: /admin/templates page errored with "Could not
-- find table 'public.reply_templates' in the schema cache". The Phase-1
-- migration 20260430160100_reply_templates_company_scoping_and_rls.sql uses
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS company_id` etc., which silently
-- becomes a no-op if the table doesn't exist — making the page-load query
-- fail downstream.
--
-- Schema matches the columns selected by /api/templates/route.ts:
--   id, company_id, account_id, title, subject, content, category, shortcut,
--   usage_count, is_active, created_by, created_at, updated_at
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS guards.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.reply_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  title text NOT NULL,
  subject text,
  content text NOT NULL DEFAULT '',
  category text,
  shortcut text,
  usage_count int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.reply_templates
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reply_templates_company
  ON public.reply_templates (company_id);
CREATE INDEX IF NOT EXISTS idx_reply_templates_account
  ON public.reply_templates (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reply_templates_shortcut_per_company
  ON public.reply_templates (company_id, shortcut)
  WHERE shortcut IS NOT NULL AND company_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_reply_templates_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reply_templates_touch_updated_at ON public.reply_templates;
CREATE TRIGGER reply_templates_touch_updated_at
  BEFORE UPDATE ON public.reply_templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_reply_templates_updated_at();

ALTER TABLE public.reply_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "templates_read"   ON public.reply_templates;
DROP POLICY IF EXISTS "templates_write"  ON public.reply_templates;
DROP POLICY IF EXISTS "templates_update" ON public.reply_templates;
DROP POLICY IF EXISTS "templates_delete" ON public.reply_templates;

CREATE POLICY "templates_read" ON public.reply_templates
  FOR SELECT TO authenticated USING (
    public.is_super_admin()
    OR company_id = public.current_user_company_id()
  );

CREATE POLICY "templates_write" ON public.reply_templates
  FOR INSERT TO authenticated WITH CHECK (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );

CREATE POLICY "templates_update" ON public.reply_templates
  FOR UPDATE TO authenticated
  USING (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  ) WITH CHECK (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );

CREATE POLICY "templates_delete" ON public.reply_templates
  FOR DELETE TO authenticated USING (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.reply_templates TO authenticated;
