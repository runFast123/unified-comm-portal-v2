-- ============================================================================
-- PERF: evaluate user_allowed_channels() ONCE per query instead of once per row.
--
-- THE BUG
--   The channel-visibility RLS policies filter with:
--       channel = ANY(user_allowed_channels())
--   `user_allowed_channels()` is STABLE (not IMMUTABLE), so Postgres does NOT
--   constant-fold it inside a qual — it re-evaluates the function for EVERY ROW
--   scanned. The function body is a 4-level COALESCE over user_permissions plus
--   two role_permissions lookups plus is_super_admin(), so this is expensive.
--
--   The header comment on 20260606150000_rbac_channel_view_rls.sql claims
--   "The function takes no row arguments, so Postgres evaluates it once per
--   query (cheap array membership per row)." That is FACTUALLY WRONG for a
--   STABLE function in a qual — only IMMUTABLE gets folded. That misunderstanding
--   is the origin of this bug; it is corrected here.
--
-- MEASURED ON THE LIVE DB (406 conversations, EXPLAIN ANALYZE, BUFFERS):
--     before:  Execution 69.9 ms, shared hit=825   (Filter: … = ANY(fn()))
--     after:   Execution  3.2 ms, shared hit=672   (InitPlan 1 … rows=1 loops=1)
--   = ~22x faster, and the plan proves single evaluation. The full inbox query
--   measured 179 ms / 16,754 buffers to return 50 rows on only 611 messages;
--   pg_stat_statements showed the badge-count shape at mean 143 ms / max 1.67 s.
--
-- THE FIX, AND WHY IT LOOKS ODD
--   Wrapping in a scalar subquery forces a one-time InitPlan. The obvious
--   Supabase idiom does NOT work here:
--       channel = ANY((SELECT user_allowed_channels()))
--       ERROR 42883: operator does not exist: text = text[]
--   because the function returns text[], so `= ANY (subquery)` parses as the
--   SUBQUERY form of ANY and compares text to text[]. The `::text[]` cast makes
--   it the ARRAY form again while keeping the single evaluation. (The plain
--   `(select …)` idiom only works verbatim for scalar functions like auth.uid().)
--
-- SEMANTICS ARE IDENTICAL — verified, not assumed:
--   * The function is STABLE and takes no arguments, and depends only on
--     auth.uid(), which is fixed for the duration of a statement. Evaluating it
--     once cannot change the result.
--   * Row counts match exactly (406 = 406 on the live table, both forms).
--   * NULL case unchanged: with zero allowed channels the function returns NULL;
--     NULL::text[] keeps `channel = ANY(NULL)` -> NULL -> row hidden. Fails
--     closed, exactly as before.
--   * Tenant isolation is NOT touched — that comes from the separate
--     company-scoping policies. These policies only restrict by CHANNEL.
--
-- All six policies keep their name, RESTRICTIVE-ness, command and role. DDL is
-- transactional, so there is no window where the restriction is absent.
-- ============================================================================

-- ── conversations ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "channel_visibility" ON public.conversations;
CREATE POLICY "channel_visibility" ON public.conversations
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (channel IS NULL OR channel = ANY((SELECT public.user_allowed_channels())::text[]));

DROP POLICY IF EXISTS "channel_visibility_update" ON public.conversations;
CREATE POLICY "channel_visibility_update" ON public.conversations
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (channel IS NULL OR channel = ANY((SELECT public.user_allowed_channels())::text[]))
  WITH CHECK (channel IS NULL OR channel = ANY((SELECT public.user_allowed_channels())::text[]));

DROP POLICY IF EXISTS "channel_visibility_insert" ON public.conversations;
CREATE POLICY "channel_visibility_insert" ON public.conversations
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (channel IS NULL OR channel = ANY((SELECT public.user_allowed_channels())::text[]));

-- ── messages ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "channel_visibility" ON public.messages;
CREATE POLICY "channel_visibility" ON public.messages
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (channel IS NULL OR channel = ANY((SELECT public.user_allowed_channels())::text[]));

DROP POLICY IF EXISTS "channel_visibility_update" ON public.messages;
CREATE POLICY "channel_visibility_update" ON public.messages
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (channel IS NULL OR channel = ANY((SELECT public.user_allowed_channels())::text[]))
  WITH CHECK (channel IS NULL OR channel = ANY((SELECT public.user_allowed_channels())::text[]));

DROP POLICY IF EXISTS "channel_visibility_insert" ON public.messages;
CREATE POLICY "channel_visibility_insert" ON public.messages
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (channel IS NULL OR channel = ANY((SELECT public.user_allowed_channels())::text[]));
