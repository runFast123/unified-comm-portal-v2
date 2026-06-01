-- ============================================================================
-- MULTI-PROVIDER AI configuration — a per-company catalog of OpenAI-compatible
-- AI providers (NVIDIA NIM, OpenAI, Groq, OpenRouter, a custom endpoint, …).
--
-- Today a company's AI provider lives as a single `ai_config` row. This table
-- lets a company SAVE MULTIPLE providers and ACTIVATE exactly one. The active
-- row is what `getAIConfig` (src/lib/api-helpers.ts) reads first — it selects
-- `base_url, api_key, model, max_tokens, temperature` from the active row and
-- falls through to the legacy `ai_config` columns when none is configured, so
-- existing tenants keep working until they add a provider here.
--
-- `provider_key` is a free-text key into the shared preset catalog
-- (src/lib/ai-providers.ts AI_PROVIDER_PRESETS — e.g. 'nvidia', 'openai',
-- 'groq', 'openrouter', 'custom'). It is advisory metadata for the UI/labels;
-- the route still validates base_url/api_key/model directly, so any
-- OpenAI-compatible endpoint works even without a matching preset.
--
-- api_key is stored PLAINTEXT, matching the existing `ai_config` table —
-- getAIConfig reads it directly with no decryption step. The HTTP layer
-- (/api/ai-providers) is responsible for never returning the raw key to a
-- client (it masks to has_api_key + api_key_masked).
--
-- Tenancy mirrors macros / company_tags / company_statuses:
--   * SELECT  → super_admin OR same company.
--   * INSERT/UPDATE/DELETE → super_admin OR (company admin AND same company).
-- Helper functions is_super_admin() / current_user_company_id() /
-- is_company_admin() come from the multi-tenancy helpers migration.
--
-- Idempotent: safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider_key text,
  base_url text NOT NULL,
  api_key text NOT NULL,
  model text NOT NULL,
  max_tokens int NOT NULL DEFAULT 4096,
  temperature numeric NOT NULL DEFAULT 1.0,
  is_active boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

COMMENT ON COLUMN public.ai_providers.provider_key IS
  'Advisory key into src/lib/ai-providers.ts AI_PROVIDER_PRESETS (e.g. nvidia | openai | groq | openrouter | custom). Drives UI labels/presets only; the actual call uses base_url/api_key/model.';
COMMENT ON COLUMN public.ai_providers.api_key IS
  'Plaintext API key (matches the legacy ai_config table). getAIConfig reads it directly. The HTTP layer masks it and never returns the raw value.';

CREATE INDEX IF NOT EXISTS idx_ai_providers_company ON public.ai_providers (company_id);

-- At most ONE active provider per company. The partial unique index lets every
-- company keep many inactive rows while guaranteeing a single active provider —
-- the route deactivates the others before activating a new one to honor this.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ai_providers_active_per_company
  ON public.ai_providers (company_id) WHERE is_active;

-- Keep updated_at fresh on every row change (same trigger pattern the rest of
-- the schema uses; the function is defined idempotently here in case this
-- migration runs before any other that creates it). SECURITY DEFINER + an
-- explicit search_path so the trigger body never resolves an unqualified name
-- against a caller-controlled search_path.
CREATE OR REPLACE FUNCTION public.touch_ai_providers_updated_at() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_providers_touch_updated_at ON public.ai_providers;
CREATE TRIGGER ai_providers_touch_updated_at
  BEFORE UPDATE ON public.ai_providers
  FOR EACH ROW EXECUTE FUNCTION public.touch_ai_providers_updated_at();

ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "AI providers read" ON public.ai_providers;
CREATE POLICY "AI providers read" ON public.ai_providers
  FOR SELECT TO authenticated USING (
    public.is_super_admin() OR company_id = public.current_user_company_id()
  );

DROP POLICY IF EXISTS "AI providers insert" ON public.ai_providers;
CREATE POLICY "AI providers insert" ON public.ai_providers
  FOR INSERT TO authenticated WITH CHECK (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );

DROP POLICY IF EXISTS "AI providers update" ON public.ai_providers;
CREATE POLICY "AI providers update" ON public.ai_providers
  FOR UPDATE TO authenticated
  USING (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  ) WITH CHECK (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );

DROP POLICY IF EXISTS "AI providers delete" ON public.ai_providers;
CREATE POLICY "AI providers delete" ON public.ai_providers
  FOR DELETE TO authenticated USING (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_providers TO authenticated;
