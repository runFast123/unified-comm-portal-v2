-- ============================================================================
-- CSAT (customer satisfaction) surveys.
-- Idempotent: safe to re-run.
--
-- 1) `csat_surveys` row per outbound survey link.
-- 2) Companies gain `csat_enabled` + email subject/body overrides so each
--    tenant can opt in and tweak the wording.
-- 3) RLS scopes reads to the conversation's account/company; writes happen
--    via the service-role client (mint + record-response paths).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.csat_surveys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  agent_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_email text,
  token text NOT NULL UNIQUE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  rating integer,
  feedback text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days')
);

-- Constrain rating to 1..5 (NULL allowed before response).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csat_surveys_rating_range'
      AND conrelid = 'public.csat_surveys'::regclass
  ) THEN
    ALTER TABLE public.csat_surveys
      ADD CONSTRAINT csat_surveys_rating_range
      CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_csat_surveys_conv ON public.csat_surveys (conversation_id);
CREATE INDEX IF NOT EXISTS idx_csat_surveys_account ON public.csat_surveys (account_id);
CREATE INDEX IF NOT EXISTS idx_csat_surveys_responded
  ON public.csat_surveys (responded_at DESC) WHERE responded_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_csat_surveys_agent
  ON public.csat_surveys (agent_user_id) WHERE agent_user_id IS NOT NULL;

ALTER TABLE public.csat_surveys ENABLE ROW LEVEL SECURITY;

-- Read policy: super_admin OR same-company. Writes go via service role.
DROP POLICY IF EXISTS "csat_read_company" ON public.csat_surveys;
CREATE POLICY "csat_read_company" ON public.csat_surveys
  FOR SELECT TO authenticated USING (
    public.is_super_admin()
    OR account_id IN (
      SELECT id FROM public.accounts WHERE company_id = public.current_user_company_id()
    )
  );

-- Per-company toggle + email body/subject overrides.
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS csat_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS csat_email_subject text DEFAULT 'How did we do?',
  ADD COLUMN IF NOT EXISTS csat_email_body text;
