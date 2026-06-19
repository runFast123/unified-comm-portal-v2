-- Per-user notification feed (the bell). DISTINCT from notification_rules,
-- which is the Slack/email routing config. Gives notifications a durable home
-- with persisted read state (read_at). Inserts are SERVICE-ROLE only (the app's
-- alert/event sources create rows); users may read/update/delete only their own
-- via RLS (user_id = auth.uid()) — strongest possible tenant scope.
--
-- Applied to prod via the Supabase MCP on 2026-06-13 (recorded remotely as
-- 20260613xxxxxx; this file is the in-repo record — see migrations README on
-- the cosmetic version-number split).
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  type text NOT NULL,            -- new_message | ai_reply_ready | escalation | system_alert
  title text NOT NULL,
  body text,
  link text,                     -- in-app deep link (/conversations/<id>, /admin/channels, ...)
  conversation_id uuid,          -- optional; no FK (conversations may be hard-deleted)
  read_at timestamptz,           -- NULL = unread
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_recent ON public.notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON public.notifications (user_id) WHERE read_at IS NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- No INSERT policy for `authenticated` → only the service-role client (which
-- bypasses RLS) can create notifications. Users only ever read/modify their own.
CREATE POLICY "Users read own notifications" ON public.notifications
  FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
CREATE POLICY "Users update own notifications" ON public.notifications
  FOR UPDATE TO authenticated USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
CREATE POLICY "Users delete own notifications" ON public.notifications
  FOR DELETE TO authenticated USING (user_id = (select auth.uid()));

COMMENT ON TABLE public.notifications IS 'Per-user notification feed (bell). Inserts are service-role only; users read/update/delete only their own via RLS.';
