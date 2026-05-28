-- Phase 3: Auto-provision new tenants at the DB layer + enable soft-archive.
--
-- This migration is purely additive:
--   1. Adds companies.archived_at (NULL = active, non-NULL = hidden from default lists).
--   2. Adds seed_company_defaults(uuid) which a new-tenant provisioning path can
--      call once to populate a sane default ai_config row, a starter set of
--      statuses, and a starter set of tags. All inserts are idempotent.
--   3. Adds a companies_active view as a convenience filter for UI default lists.
--
-- RLS policies are NOT touched here (Phase 1 + Phase 2 already correct).

-- =========================================================================
-- Part 1: archived_at on companies
-- =========================================================================

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_companies_archived_at
  ON public.companies (archived_at)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN public.companies.archived_at IS
  'Phase 3: soft-archive timestamp. NULL = active. Non-null = hidden from default lists. Use UI Restore to clear.';

-- =========================================================================
-- Part 2: seed_company_defaults(p_company_id uuid)
-- =========================================================================
--
-- Idempotent. Safe to call multiple times on the same company. Intended to be
-- invoked from /api/admin/companies right after a new company row is inserted
-- (service-role context). Marked SECURITY DEFINER as belt-and-braces so the
-- function works even from non-service-role contexts that still hold a valid
-- companies.id reference.

CREATE OR REPLACE FUNCTION public.seed_company_defaults(p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_template public.ai_config%ROWTYPE;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'seed_company_defaults: p_company_id is required';
  END IF;

  -- ----- ai_config -----
  -- The "one active per company" uniqueness is a partial unique INDEX, not a
  -- named constraint, so we can't use ON CONFLICT ON CONSTRAINT against it.
  -- Simplest idempotency: only insert if the company has no ai_config row yet.
  IF NOT EXISTS (
    SELECT 1 FROM public.ai_config WHERE company_id = p_company_id
  ) THEN
    -- Clone the most recently updated active ai_config (any tenant) as a
    -- template; fall back to hard-coded defaults from the column schema.
    SELECT *
      INTO v_template
      FROM public.ai_config
     WHERE is_active = true
       AND company_id IS DISTINCT FROM p_company_id
     ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
     LIMIT 1;

    IF FOUND THEN
      INSERT INTO public.ai_config (
        company_id,
        provider_name,
        base_url,
        api_key,
        model,
        max_tokens,
        temperature,
        email_prompt,
        teams_prompt,
        whatsapp_prompt,
        confidence_threshold,
        trust_threshold,
        fallback_behavior,
        auto_resolve_marketing,
        is_active
      )
      VALUES (
        p_company_id,
        v_template.provider_name,
        v_template.base_url,
        ''::text,  -- never copy api_key across tenants
        v_template.model,
        v_template.max_tokens,
        v_template.temperature,
        v_template.email_prompt,
        v_template.teams_prompt,
        v_template.whatsapp_prompt,
        v_template.confidence_threshold,
        v_template.trust_threshold,
        v_template.fallback_behavior,
        v_template.auto_resolve_marketing,
        true
      );
    ELSE
      INSERT INTO public.ai_config (
        company_id,
        provider_name,
        base_url,
        api_key,
        model,
        max_tokens,
        temperature,
        confidence_threshold,
        trust_threshold,
        fallback_behavior,
        auto_resolve_marketing,
        is_active
      )
      VALUES (
        p_company_id,
        'NVIDIA',
        'https://integrate.api.nvidia.com/v1',
        ''::text,
        'moonshotai/kimi-k2.5',
        4096,
        1.0,
        0.80,
        5,
        'escalate',
        false,
        true
      );
    END IF;
  END IF;

  -- ----- company_statuses -----
  -- Unique index: (company_id, lower(name)) WHERE is_active. Use that as the
  -- conflict target so re-running this function never duplicates a status.
  INSERT INTO public.company_statuses (company_id, name, color, sort_order, is_active)
  VALUES
    (p_company_id, 'New',                  '#3b82f6', 10, true),  -- blue
    (p_company_id, 'In Progress',          '#f59e0b', 20, true),  -- amber
    (p_company_id, 'Waiting on Customer',  '#a855f7', 30, true),  -- purple
    (p_company_id, 'Resolved',             '#22c55e', 40, true),  -- green
    (p_company_id, 'Closed',               '#6b7280', 50, true)   -- gray
  ON CONFLICT (company_id, lower(name)) WHERE is_active DO NOTHING;

  -- ----- company_tags -----
  -- Unique index: (company_id, lower(name)).
  INSERT INTO public.company_tags (company_id, name, color)
  VALUES
    (p_company_id, 'VIP',              '#eab308'),  -- yellow
    (p_company_id, 'Bug Report',       '#ef4444'),  -- red
    (p_company_id, 'Feature Request',  '#8b5cf6'),  -- violet
    (p_company_id, 'Billing',          '#14b8a6'),  -- teal
    (p_company_id, 'Sales Lead',       '#22c55e')   -- green
  ON CONFLICT (company_id, lower(name)) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION public.seed_company_defaults(uuid) IS
  'Phase 3: idempotently seeds a default ai_config row, starter statuses, and starter tags for a new company. Safe to re-run.';

REVOKE ALL ON FUNCTION public.seed_company_defaults(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_company_defaults(uuid) TO authenticated, service_role;

-- =========================================================================
-- Part 3: companies_active view
-- =========================================================================

CREATE OR REPLACE VIEW public.companies_active AS
  SELECT * FROM public.companies WHERE archived_at IS NULL;

COMMENT ON VIEW public.companies_active IS
  'Companies with NULL archived_at (UI default list filter). RLS on the underlying companies table still applies.';

GRANT SELECT ON public.companies_active TO authenticated;
