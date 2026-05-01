-- ============================================================================
-- Per-company custom statuses + tags catalogs.
--
-- The base `conversations.status` ENUM is kept for built-in lifecycle (active,
-- in_progress, waiting_on_customer, resolved, escalated, archived) so we don't
-- have to ALTER an enum (risky in Postgres). A parallel `secondary_status`
-- text column lets each company attach their own sub-status drawn from the
-- `company_statuses` catalog.
--
-- `company_tags` mirrors that for tags — `conversations.tags text[]` is
-- already free-form, this catalog just powers autocomplete + colors in the UI.
--
-- All idempotent.
-- ============================================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS secondary_status text,
  ADD COLUMN IF NOT EXISTS secondary_status_color text;

-- ── Company statuses catalog ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.company_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#6b7280',
  description text,
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_statuses_name
  ON public.company_statuses (company_id, lower(name)) WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_company_statuses_company
  ON public.company_statuses (company_id, sort_order);

ALTER TABLE public.company_statuses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Statuses read" ON public.company_statuses;
CREATE POLICY "Statuses read" ON public.company_statuses
  FOR SELECT TO authenticated USING (
    is_super_admin() OR company_id = current_user_company_id()
  );

DROP POLICY IF EXISTS "Statuses manage" ON public.company_statuses;
CREATE POLICY "Statuses manage" ON public.company_statuses
  FOR ALL TO authenticated USING (
    is_super_admin() OR (company_id = current_user_company_id() AND is_company_admin())
  ) WITH CHECK (
    is_super_admin() OR (company_id = current_user_company_id() AND is_company_admin())
  );

-- ── Company tags catalog ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.company_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#6b7280',
  description text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_tags_name
  ON public.company_tags (company_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_company_tags_company
  ON public.company_tags (company_id);

ALTER TABLE public.company_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tags read" ON public.company_tags;
CREATE POLICY "Tags read" ON public.company_tags
  FOR SELECT TO authenticated USING (
    is_super_admin() OR company_id = current_user_company_id()
  );

DROP POLICY IF EXISTS "Tags manage" ON public.company_tags;
CREATE POLICY "Tags manage" ON public.company_tags
  FOR ALL TO authenticated USING (
    is_super_admin() OR (company_id = current_user_company_id() AND is_company_admin())
  ) WITH CHECK (
    is_super_admin() OR (company_id = current_user_company_id() AND is_company_admin())
  );
