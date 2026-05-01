-- ============================================================================
-- Per-company API tokens + outgoing webhook subscriptions + delivery audit.
--
-- Builds the foundation for customer-facing integrations (Zapier, n8n, custom
-- code, CRMs):
--   * api_tokens — opaque bearer tokens minted per company. Plaintext is
--     shown to the user once at creation; only the SHA-256 hash is stored.
--   * webhook_subscriptions — outgoing HTTP subscriptions filtered by event
--     type, signed via HMAC using a per-subscription signing_secret.
--   * webhook_deliveries — append-only audit trail so admins can debug
--     failed deliveries.
--
-- All idempotent. RLS pins everything to (super_admin OR own-company-admin).
-- ============================================================================

-- ── api_tokens ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Store ONLY the SHA-256 hash. The plaintext is shown to the user once at creation.
  token_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,                 -- first 8 chars for UI display ("ucp_abc1...")
  scopes text[] NOT NULL DEFAULT '{}',  -- e.g. ['conversations:read', 'messages:write']
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_company ON public.api_tokens (company_id);

ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "api_tokens_company_admin" ON public.api_tokens;
CREATE POLICY "api_tokens_company_admin" ON public.api_tokens
  FOR ALL TO authenticated
  USING (
    is_super_admin() OR
    (company_id = current_user_company_id() AND is_company_admin())
  )
  WITH CHECK (
    is_super_admin() OR
    (company_id = current_user_company_id() AND is_company_admin())
  );

-- ── webhook_subscriptions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  url text NOT NULL,
  events text[] NOT NULL,               -- ['conversation.created', 'conversation.resolved', 'message.received']
  signing_secret text NOT NULL,         -- shared secret for HMAC; we generate
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_delivery_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_webhook_subs_company ON public.webhook_subscriptions (company_id);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_active ON public.webhook_subscriptions (is_active) WHERE is_active;

ALTER TABLE public.webhook_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_subs_company_admin" ON public.webhook_subscriptions;
CREATE POLICY "webhook_subs_company_admin" ON public.webhook_subscriptions
  FOR ALL TO authenticated
  USING (
    is_super_admin() OR
    (company_id = current_user_company_id() AND is_company_admin())
  )
  WITH CHECK (
    is_super_admin() OR
    (company_id = current_user_company_id() AND is_company_admin())
  );

-- ── webhook_deliveries (audit trail for debug) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.webhook_subscriptions(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload_excerpt text,                 -- first 500 chars
  http_status integer,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer,
  error text,
  retry_count integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub_attempted
  ON public.webhook_deliveries (subscription_id, attempted_at DESC);

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_deliveries_read" ON public.webhook_deliveries;
CREATE POLICY "webhook_deliveries_read" ON public.webhook_deliveries
  FOR SELECT TO authenticated USING (
    is_super_admin() OR
    subscription_id IN (
      SELECT id FROM public.webhook_subscriptions WHERE company_id = current_user_company_id()
    )
  );
