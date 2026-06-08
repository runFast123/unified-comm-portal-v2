-- Hard channel view-isolation via RLS. A user can only SELECT conversations /
-- messages on channels they're granted. Mirrors the TS resolver: per-user
-- override -> company role delta -> platform role delta -> baseline (all
-- channels). The function takes no row arguments, so Postgres evaluates it once
-- per query (cheap array membership per row). service-role bypasses RLS, so
-- server routes are unaffected. NON-BREAKING: default role perms grant every
-- channel, so all-channel users see no change.
--
-- NOTE: the baseline here is "all channels allowed" — it MUST stay in sync with
-- DEFAULT_ROLE_PERMISSIONS in src/lib/permissions/defaults.ts (every role gets
-- all CHANNEL_PERMISSION_KEYS). If that ever changes, update this function.

CREATE OR REPLACE FUNCTION public.user_allowed_channels()
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (
    SELECT id, role::text AS role, company_id FROM public.users WHERE id = auth.uid()
  ),
  base AS (
    SELECT unnest(ARRAY['email','teams','whatsapp','sms','telegram','messenger','instagram']) AS ch
  )
  SELECT
    CASE WHEN public.is_super_admin() THEN (SELECT array_agg(ch) FROM base)
    ELSE (
      SELECT array_agg(b.ch) FROM base b
      WHERE COALESCE(
        (SELECT (up.effect = 'allow') FROM public.user_permissions up
           WHERE up.user_id = (SELECT id FROM me) AND up.permission_key = 'channel:' || b.ch LIMIT 1),
        (SELECT rp.allowed FROM public.role_permissions rp
           WHERE rp.company_id = (SELECT company_id FROM me) AND rp.role = (SELECT role FROM me)
             AND rp.permission_key = 'channel:' || b.ch LIMIT 1),
        (SELECT rp.allowed FROM public.role_permissions rp
           WHERE rp.company_id IS NULL AND rp.role = (SELECT role FROM me)
             AND rp.permission_key = 'channel:' || b.ch LIMIT 1),
        true
      )
    )
    END
$$;

REVOKE ALL ON FUNCTION public.user_allowed_channels() FROM public;
GRANT EXECUTE ON FUNCTION public.user_allowed_channels() TO authenticated;

DROP POLICY IF EXISTS "channel_visibility" ON public.conversations;
CREATE POLICY "channel_visibility" ON public.conversations
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (channel IS NULL OR channel = ANY(public.user_allowed_channels()));

DROP POLICY IF EXISTS "channel_visibility" ON public.messages;
CREATE POLICY "channel_visibility" ON public.messages
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (channel IS NULL OR channel = ANY(public.user_allowed_channels()));
