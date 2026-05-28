-- ============================================================================
-- ai_config: scope to one row per company (close cross-tenant config leak)
--
-- Previously the table was treated as a single global active row — any
-- company_admin saving the AI Settings page would overwrite every tenant's
-- AI provider/key/model/prompts. This migration:
--
--   1. Ensures the table exists with all columns the app expects (the
--      schema was previously created out-of-band and is missing from the
--      migrations folder, so we (re)create it idempotently here).
--   2. Adds `company_id uuid REFERENCES companies(id) ON DELETE CASCADE`,
--      nullable. NULL = legacy/global fallback for code paths that have no
--      company context.
--   3. Adds a unique partial index ensuring at most ONE active row per
--      company, plus one for the NULL/global row.
--   4. Backfills one row per company. If a current global active row
--      exists, clones its provider/prompt/threshold values into each
--      tenant's row. If not, seeds a minimal default per company.
--   5. After backfill, marks the legacy global row inactive (but keeps it
--      as a read-only fallback).
--   6. Replaces RLS policies so company_admins can only read/write rows
--      scoped to their own company. The legacy NULL/global row is
--      readable by any admin (fallback) but writable only by super_admin.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ── 1. Table baseline (idempotent) ──────────────────────────────────────────
-- Mirrors the columns the app reads/writes today in:
--   - src/lib/api-helpers.ts (getAIConfig)
--   - src/app/api/classify/route.ts (isAutoResolveMarketingEnabled)
--   - src/app/(dashboard)/admin/ai-settings/ai-settings-client.tsx
CREATE TABLE IF NOT EXISTS public.ai_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name text NOT NULL DEFAULT 'NVIDIA',
  base_url text NOT NULL DEFAULT 'https://integrate.api.nvidia.com/v1',
  api_key text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT 'moonshotai/kimi-k2.5',
  max_tokens integer NOT NULL DEFAULT 4096,
  temperature numeric(4,2) NOT NULL DEFAULT 1.0,
  email_prompt text,
  teams_prompt text,
  whatsapp_prompt text,
  confidence_threshold numeric(4,2) NOT NULL DEFAULT 0.80,
  trust_threshold integer NOT NULL DEFAULT 5,
  fallback_behavior text NOT NULL DEFAULT 'escalate',
  auto_resolve_marketing boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Make sure existing prod DBs that may have had this table created
-- out-of-band gain the columns the current code expects.
ALTER TABLE public.ai_config
  ADD COLUMN IF NOT EXISTS provider_name text DEFAULT 'NVIDIA',
  ADD COLUMN IF NOT EXISTS base_url text,
  ADD COLUMN IF NOT EXISTS api_key text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS max_tokens integer DEFAULT 4096,
  ADD COLUMN IF NOT EXISTS temperature numeric(4,2) DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS email_prompt text,
  ADD COLUMN IF NOT EXISTS teams_prompt text,
  ADD COLUMN IF NOT EXISTS whatsapp_prompt text,
  ADD COLUMN IF NOT EXISTS confidence_threshold numeric(4,2) DEFAULT 0.80,
  ADD COLUMN IF NOT EXISTS trust_threshold integer DEFAULT 5,
  ADD COLUMN IF NOT EXISTS fallback_behavior text DEFAULT 'escalate',
  ADD COLUMN IF NOT EXISTS auto_resolve_marketing boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- ── 2. Add company_id ───────────────────────────────────────────────────────
ALTER TABLE public.ai_config
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE;

-- ── 3. Indexes ─────────────────────────────────────────────────────────────-
CREATE INDEX IF NOT EXISTS ai_config_company_active_idx
  ON public.ai_config (company_id, is_active);

-- At most one active row per company.
DROP INDEX IF EXISTS public.ai_config_one_active_per_company;
CREATE UNIQUE INDEX ai_config_one_active_per_company
  ON public.ai_config (company_id)
  WHERE is_active = true AND company_id IS NOT NULL;

-- At most one active global/legacy row (company_id IS NULL).
DROP INDEX IF EXISTS public.ai_config_one_active_global;
CREATE UNIQUE INDEX ai_config_one_active_global
  ON public.ai_config ((1))
  WHERE is_active = true AND company_id IS NULL;

-- ── 4. Backfill: one row per company ────────────────────────────────────────
-- Before insert, demote any duplicate active per-company rows (none should
-- exist yet, but the unique index would otherwise reject the backfill if a
-- prior partial run inserted one). Keeps the most-recently-updated row.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM public.ai_config
  WHERE is_active = true AND company_id IS NOT NULL
)
UPDATE public.ai_config
SET is_active = false
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Insert one row per company that does NOT yet have an active per-company
-- row. Values come from the current global active row when present; otherwise
-- the column defaults take over.
WITH legacy AS (
  SELECT
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
    auto_resolve_marketing
  FROM public.ai_config
  WHERE is_active = true AND company_id IS NULL
  ORDER BY created_at DESC
  LIMIT 1
),
needs_row AS (
  SELECT c.id AS company_id
  FROM public.companies c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.ai_config a
    WHERE a.company_id = c.id AND a.is_active = true
  )
)
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
SELECT
  n.company_id,
  COALESCE((SELECT provider_name FROM legacy), 'NVIDIA'),
  COALESCE((SELECT base_url FROM legacy), 'https://integrate.api.nvidia.com/v1'),
  COALESCE((SELECT api_key FROM legacy), ''),
  COALESCE((SELECT model FROM legacy), 'moonshotai/kimi-k2.5'),
  COALESCE((SELECT max_tokens FROM legacy), 4096),
  COALESCE((SELECT temperature FROM legacy), 1.0),
  (SELECT email_prompt FROM legacy),
  (SELECT teams_prompt FROM legacy),
  (SELECT whatsapp_prompt FROM legacy),
  COALESCE((SELECT confidence_threshold FROM legacy), 0.80),
  COALESCE((SELECT trust_threshold FROM legacy), 5),
  COALESCE((SELECT fallback_behavior FROM legacy), 'escalate'),
  COALESCE((SELECT auto_resolve_marketing FROM legacy), false),
  true
FROM needs_row n;

-- ── 5. Deactivate the legacy global active row ─────────────────────────────
-- Keep the row as a read-only fallback for any code path that runs without
-- a company context. The unique partial index on the global row would also
-- block any future accidental activation while another global row is active.
UPDATE public.ai_config
SET is_active = false
WHERE company_id IS NULL AND is_active = true;

-- ── 6. RLS policies ─────────────────────────────────────────────────────────
ALTER TABLE public.ai_config ENABLE ROW LEVEL SECURITY;

-- Drop ALL existing policies on ai_config so we start clean. We don't know
-- the names of any policies that may have been added out-of-band, so iterate
-- pg_policy and drop dynamically.
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT polname FROM pg_policy WHERE polrelid = 'public.ai_config'::regclass
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.ai_config', pol.polname);
  END LOOP;
END$$;

-- SELECT: super_admin sees all; admins see their own company row + legacy
-- global fallback row.
CREATE POLICY "ai_config select"
  ON public.ai_config
  FOR SELECT
  TO authenticated
  USING (
    is_super_admin()
    OR (is_admin() AND company_id = current_user_company_id())
    OR (is_admin() AND company_id IS NULL)
  );

-- INSERT: super_admin (any row including NULL global); company_admins only
-- for their own company.
CREATE POLICY "ai_config insert"
  ON public.ai_config
  FOR INSERT
  TO authenticated
  WITH CHECK (
    is_super_admin()
    OR (is_admin() AND company_id = current_user_company_id())
  );

-- UPDATE: same scope as INSERT. The NULL/global row is reserved for
-- super_admin — company_admins cannot mutate it.
CREATE POLICY "ai_config update"
  ON public.ai_config
  FOR UPDATE
  TO authenticated
  USING (
    is_super_admin()
    OR (is_admin() AND company_id = current_user_company_id())
  )
  WITH CHECK (
    is_super_admin()
    OR (is_admin() AND company_id = current_user_company_id())
  );

-- DELETE: super_admin OR same-company admin.
CREATE POLICY "ai_config delete"
  ON public.ai_config
  FOR DELETE
  TO authenticated
  USING (
    is_super_admin()
    OR (is_admin() AND company_id = current_user_company_id())
  );
