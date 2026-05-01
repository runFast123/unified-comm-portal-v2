-- ============================================================================
-- Per-conversation time tracking — auto-tracking via "view sessions".
--
-- When a user opens a conversation page, the client starts a session row;
-- a heartbeat extends it every minute; on tab-close (sendBeacon) or
-- after 5 min of staleness (cron GC) the session is closed and a
-- duration is computed.
--
-- Used for billing, throughput measurement, and identifying high-effort
-- conversations.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.conversation_time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,                 -- NULL while session is active
  duration_seconds integer,             -- computed at end (denormalized for fast aggregates)
  source text NOT NULL DEFAULT 'auto',  -- 'auto' (heartbeat) or 'manual' (agent set explicitly)
  notes text,                           -- optional manual entry note
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_time_entries_conv
  ON public.conversation_time_entries (conversation_id, started_at);
CREATE INDEX IF NOT EXISTS idx_time_entries_user_day
  ON public.conversation_time_entries (user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_time_entries_account
  ON public.conversation_time_entries (account_id);

ALTER TABLE public.conversation_time_entries ENABLE ROW LEVEL SECURITY;

-- ── RLS policies ────────────────────────────────────────────────────
-- Read: super_admin sees everything; user sees their own; company_admin
-- sees all entries for accounts in their own company.
DROP POLICY IF EXISTS "time_entries_read" ON public.conversation_time_entries;
CREATE POLICY "time_entries_read" ON public.conversation_time_entries
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR user_id = auth.uid()
    OR (
      is_company_admin()
      AND account_id IN (
        SELECT id FROM public.accounts
        WHERE company_id = current_user_company_id()
      )
    )
  );

-- Write (insert): user can only create rows for themselves.
DROP POLICY IF EXISTS "time_entries_write" ON public.conversation_time_entries;
CREATE POLICY "time_entries_write" ON public.conversation_time_entries
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- Update: user can only update their own rows.
DROP POLICY IF EXISTS "time_entries_update" ON public.conversation_time_entries;
CREATE POLICY "time_entries_update" ON public.conversation_time_entries
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
