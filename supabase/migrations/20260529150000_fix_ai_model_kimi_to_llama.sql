-- ============================================================================
-- Fix the configured AI model. NVIDIA retired `moonshotai/kimi-k2.5`, so every
-- AI call (classify, suggest-replies, ai-reply, ai-compose, ai-summarize) was
-- returning HTTP 404 and 500ing since ~2026-05-08 (last successful ai_usage row
-- is from that date). The direct successor `kimi-k2.6` cold-starts well past
-- the app's 30s AI timeout, so we standardise on `meta/llama-3.3-70b-instruct`
-- — verified live against NVIDIA (200, ~0.5s), high quality, reliable
-- structured (JSON) output for the classifier.
--
--   1. Repoint existing ai_config rows off the dead model.
--   2. Change the column default for future inserts.
--   3. Update seed_company_defaults() so a newly-provisioned company with no
--      existing template to copy from gets the working model (was hard-coded
--      to the dead 'moonshotai/kimi-k2.5'). Body is otherwise unchanged.
--
-- Idempotent.
-- ============================================================================

UPDATE public.ai_config
   SET model = 'meta/llama-3.3-70b-instruct'
 WHERE model = 'moonshotai/kimi-k2.5';

ALTER TABLE public.ai_config ALTER COLUMN model SET DEFAULT 'meta/llama-3.3-70b-instruct';

CREATE OR REPLACE FUNCTION public.seed_company_defaults(p_company_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_template public.ai_config%ROWTYPE;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'seed_company_defaults: p_company_id is required';
  END IF;

  -- Skip ai_config insert entirely if one already exists for this company
  -- (active or not). Simpler + cheaper than relying on partial-index conflict.
  IF NOT EXISTS (
    SELECT 1 FROM public.ai_config WHERE company_id = p_company_id
  ) THEN
    SELECT *
      INTO v_template
      FROM public.ai_config
     WHERE is_active = true
       AND company_id IS DISTINCT FROM p_company_id
     ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
     LIMIT 1;

    IF FOUND THEN
      INSERT INTO public.ai_config (
        company_id, provider_name, base_url, api_key, model, max_tokens, temperature,
        email_prompt, teams_prompt, whatsapp_prompt, confidence_threshold,
        trust_threshold, fallback_behavior, auto_resolve_marketing, is_active
      )
      VALUES (
        p_company_id, v_template.provider_name, v_template.base_url, ''::text,
        v_template.model, v_template.max_tokens, v_template.temperature,
        v_template.email_prompt, v_template.teams_prompt, v_template.whatsapp_prompt,
        v_template.confidence_threshold, v_template.trust_threshold,
        v_template.fallback_behavior, v_template.auto_resolve_marketing, true
      );
    ELSE
      INSERT INTO public.ai_config (
        company_id, provider_name, base_url, api_key, model, max_tokens, temperature,
        confidence_threshold, trust_threshold, fallback_behavior,
        auto_resolve_marketing, is_active
      )
      VALUES (
        p_company_id, 'NVIDIA', 'https://integrate.api.nvidia.com/v1', ''::text,
        'meta/llama-3.3-70b-instruct', 4096, 1.0, 0.80, 5, 'escalate', false, true
      );
    END IF;
  END IF;

  -- company_statuses: partial unique index on (company_id, lower(name)) WHERE is_active.
  INSERT INTO public.company_statuses (company_id, name, color, sort_order, is_active)
  VALUES
    (p_company_id, 'New',                  '#3b82f6', 10, true),
    (p_company_id, 'In Progress',          '#f59e0b', 20, true),
    (p_company_id, 'Waiting on Customer',  '#a855f7', 30, true),
    (p_company_id, 'Resolved',             '#22c55e', 40, true),
    (p_company_id, 'Closed',               '#6b7280', 50, true)
  ON CONFLICT (company_id, lower(name)) WHERE is_active DO NOTHING;

  -- company_tags: unique index on (company_id, lower(name)) (no predicate).
  INSERT INTO public.company_tags (company_id, name, color)
  VALUES
    (p_company_id, 'VIP',              '#eab308'),
    (p_company_id, 'Bug Report',       '#ef4444'),
    (p_company_id, 'Feature Request',  '#8b5cf6'),
    (p_company_id, 'Billing',          '#14b8a6'),
    (p_company_id, 'Sales Lead',       '#22c55e')
  ON CONFLICT (company_id, lower(name)) DO NOTHING;
END;
$function$;
