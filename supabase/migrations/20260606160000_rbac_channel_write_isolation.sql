-- Extend channel isolation from view (SELECT, migration 20260606150000) to
-- WRITES: a channel-restricted user cannot UPDATE or INSERT conversations /
-- messages on channels they're not granted either. Same RESTRICTIVE pattern +
-- the same public.user_allowed_channels() resolver. ANDs onto the existing
-- PERMISSIVE company-scope write policies. (DELETE has no permissive policy for
-- authenticated, so it is already denied — nothing to add.)
--
-- NON-BREAKING: default role perms grant every channel, so all-channel users
-- (everyone, until an admin restricts) are unaffected. service-role bypasses RLS,
-- so server ingestion / send routes are unaffected.

-- conversations
DROP POLICY IF EXISTS "channel_visibility_update" ON public.conversations;
CREATE POLICY "channel_visibility_update" ON public.conversations
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (channel IS NULL OR channel = ANY(public.user_allowed_channels()))
  WITH CHECK (channel IS NULL OR channel = ANY(public.user_allowed_channels()));

DROP POLICY IF EXISTS "channel_visibility_insert" ON public.conversations;
CREATE POLICY "channel_visibility_insert" ON public.conversations
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (channel IS NULL OR channel = ANY(public.user_allowed_channels()));

-- messages
DROP POLICY IF EXISTS "channel_visibility_update" ON public.messages;
CREATE POLICY "channel_visibility_update" ON public.messages
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (channel IS NULL OR channel = ANY(public.user_allowed_channels()))
  WITH CHECK (channel IS NULL OR channel = ANY(public.user_allowed_channels()));

DROP POLICY IF EXISTS "channel_visibility_insert" ON public.messages;
CREATE POLICY "channel_visibility_insert" ON public.messages
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (channel IS NULL OR channel = ANY(public.user_allowed_channels()));
