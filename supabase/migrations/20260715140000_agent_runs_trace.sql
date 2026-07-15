-- ============================================================================
-- Agent run traces.
--
-- WHY
--   An agent is non-deterministic: you cannot unit-test "was that the right
--   call?" the way you can test a pure function. The only way to operate one is
--   to be able to read back exactly what it did — which tools it called, what
--   came back, and what it concluded. Without that, "why did the AI escalate
--   this?" has no answer and nobody will ever trust it enough to turn it on.
--
--   This is also what makes shadow mode possible: record what the agent WOULD
--   have done (shadow = true), apply none of it, and compare against what the
--   human actually did. That is how you earn the right to let it act.
--
--   Note the existing single-shot AI path has none of this — /api/classify
--   returns a category with no record of why. These tables are the upgrade.
--
-- TENANCY
--   Scoped via account_id -> accounts.company_id, mirroring ai_usage exactly.
--   Steps inherit scope through their run (same pattern as
--   message_classifications reaching account_id through messages). Writes are
--   service-role only; RLS grants company-scoped READ so the trace can be shown
--   in the UI to the people who own the conversation.
--
-- RETENTION
--   Steps hold conversation text (a customer's own words, echoed back through
--   tool results), so these rows are as sensitive as `messages` and should age
--   out with them. See the retention-purge cron; agent_runs is NOT yet wired
--   into it. TODO before this carries real traffic at volume.
--
-- Idempotent; safe to re-apply.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  -- The human the agent acted for. All of the run's authority derived from this
  -- user's permissions, so the trace is meaningless without it.
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  endpoint text NOT NULL,
  request_id text,
  input text NOT NULL,
  answer text,
  -- answered | max_steps | deadline | no_tool_support | error
  stop_reason text NOT NULL,
  model text,
  model_calls integer NOT NULL DEFAULT 0,
  tool_calls integer NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  -- TRUE = decisions recorded but deliberately NOT applied. The whole point of
  -- shadow mode, and the flag every comparison report filters on.
  shadow boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  -- 1-based execution order. The trace is only readable in sequence.
  idx integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('model', 'tool')),
  content text,
  tool_name text,
  tool_args jsonb,
  tool_result jsonb,
  tool_ok boolean,
  tool_error text,
  duration_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agent_runs IS
  'One agent loop execution. Written service-role only by src/lib/ai/trace.ts; read company-scoped via RLS. shadow=true means the run''s decisions were recorded but NOT applied.';
COMMENT ON TABLE public.agent_run_steps IS
  'Ordered steps of an agent run (idx is 1-based): each model turn and each tool call with its arguments and result. This is the "why did the AI do that" record.';
COMMENT ON COLUMN public.agent_runs.shadow IS
  'TRUE when the run was evaluated but nothing was applied. Comparison/agreement reports must filter on this.';

-- Trace lookups are "this conversation's runs" and "recent runs for this
-- account"; steps are always fetched whole, in order, for one run.
CREATE INDEX IF NOT EXISTS idx_agent_runs_account_created
  ON public.agent_runs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation
  ON public.agent_runs (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run
  ON public.agent_run_steps (run_id, idx);

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_run_steps ENABLE ROW LEVEL SECURITY;

-- Mirrors the ai_usage policy: company-scoped read, no write policy at all
-- (service-role bypasses RLS; everyone else is locked closed by default).
DROP POLICY IF EXISTS "Users read own company agent_runs" ON public.agent_runs;
CREATE POLICY "Users read own company agent_runs" ON public.agent_runs
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );

-- Steps have no account_id of their own; scope reaches them through the run,
-- the same way message_classifications scopes through messages.
DROP POLICY IF EXISTS "Users read own company agent_run_steps" ON public.agent_run_steps;
CREATE POLICY "Users read own company agent_run_steps" ON public.agent_run_steps
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR EXISTS (
      SELECT 1
        FROM public.agent_runs r
        JOIN public.accounts a ON a.id = r.account_id
       WHERE r.id = agent_run_steps.run_id
         AND a.company_id = current_user_company_id()
    )
  );
