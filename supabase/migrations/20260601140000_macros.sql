-- ============================================================================
-- Workflow MACROS — reusable, named bundles of one-click conversation actions.
--
-- A macro is a saved set of actions an agent applies to a conversation in one
-- click: set status, add tags, assign to a user, set priority. Macros NEVER
-- send a message — sending always requires explicit human approval in this app.
-- A macro MAY reference a `reply_template_id` so the composer can INSERT the
-- template's text for the agent to review/edit, but it is never auto-sent.
--
-- `actions` is a JSON object. Documented shape (all keys optional):
--   {
--     set_status?:        string,    -- a company_statuses.name for this company
--     add_tags?:          string[],  -- merged into conversations.tags (text[])
--     assign_to?:         uuid|null, -- a users.id in the SAME company (null = unassign)
--     set_priority?:      string,    -- one of: low | medium | high | urgent
--     reply_template_id?: uuid       -- composer INSERTs this template's text (never sends)
--   }
--
-- Tenancy mirrors company_statuses / company_tags / reply_templates:
--   * SELECT  → super_admin OR same company.
--   * INSERT/UPDATE/DELETE → super_admin OR (company admin AND same company).
-- Helper functions is_super_admin() / current_user_company_id() /
-- is_company_admin() come from the multi-tenancy helpers migration.
--
-- Idempotent: safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.macros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  actions jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Document the JSON contract at the column level so it's discoverable via \d+.
COMMENT ON COLUMN public.macros.actions IS
  'One-click action bundle. Shape: { set_status?: string, add_tags?: string[], assign_to?: uuid|null, set_priority?: string, reply_template_id?: uuid }. Never sends a message — reply_template_id only tells the composer to INSERT template text for human review.';

CREATE INDEX IF NOT EXISTS idx_macros_company ON public.macros (company_id);

-- One active macro name per company (case-insensitive). Inactive rows are
-- excluded so a soft-deleted macro's name can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_macros_name_per_company
  ON public.macros (company_id, lower(name)) WHERE is_active;

-- Keep updated_at fresh on every row change (same trigger pattern the rest of
-- the schema uses; the function is defined idempotently here in case this
-- migration runs before any other that creates it).
CREATE OR REPLACE FUNCTION public.touch_macros_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS macros_touch_updated_at ON public.macros;
CREATE TRIGGER macros_touch_updated_at
  BEFORE UPDATE ON public.macros
  FOR EACH ROW EXECUTE FUNCTION public.touch_macros_updated_at();

ALTER TABLE public.macros ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Macros read" ON public.macros;
CREATE POLICY "Macros read" ON public.macros
  FOR SELECT TO authenticated USING (
    public.is_super_admin() OR company_id = public.current_user_company_id()
  );

DROP POLICY IF EXISTS "Macros insert" ON public.macros;
CREATE POLICY "Macros insert" ON public.macros
  FOR INSERT TO authenticated WITH CHECK (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );

DROP POLICY IF EXISTS "Macros update" ON public.macros;
CREATE POLICY "Macros update" ON public.macros
  FOR UPDATE TO authenticated
  USING (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  ) WITH CHECK (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );

DROP POLICY IF EXISTS "Macros delete" ON public.macros;
CREATE POLICY "Macros delete" ON public.macros
  FOR DELETE TO authenticated USING (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.macros TO authenticated;
