-- ============================================================================
-- Postgres full-text search for the unified inbox.
--
-- GIN full-text indexes over the searchable text on conversations and messages,
-- plus a SECURITY DEFINER `search_conversations()` RPC that powers the global
-- search box.
--
-- NOTE: `conversations` has NO email_subject column (the subject lives on
-- `messages`). The conversation "header" document is participant name/email +
-- ai_summary; message bodies (including email_subject) are matched via the
-- msg_match CTE so a hit in a message body surfaces its conversation.
--
-- ── TENANCY GUARANTEE ──────────────────────────────────────────────────────
-- search_conversations is SECURITY DEFINER (one efficient FTS query past RLS)
-- but re-implements the SAME company scope the conversations/messages RLS
-- policies enforce:
--     is_super_admin()
--       OR c.account_id IN (SELECT id FROM public.accounts
--                           WHERE company_id = current_user_company_id())
-- Both helpers key off auth.uid(), so the function is tenant-safe ONLY when
-- invoked on the user-context client. On the service-role client auth.uid() is
-- NULL → zero rows (fail-closed), never a cross-tenant leak. EXECUTE is granted
-- to `authenticated` only. search_path is pinned to public.
--
-- Idempotent: CREATE INDEX ... IF NOT EXISTS + CREATE OR REPLACE FUNCTION.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_messages_fts
  ON public.messages
  USING gin (to_tsvector('english', coalesce(message_text, '') || ' ' || coalesce(email_subject, '')));

CREATE INDEX IF NOT EXISTS idx_conversations_fts
  ON public.conversations
  USING gin (to_tsvector('english', coalesce(participant_name, '') || ' ' || coalesce(participant_email, '') || ' ' || coalesce(ai_summary, '')));

CREATE INDEX IF NOT EXISTS idx_conversations_account_last_message
  ON public.conversations (account_id, last_message_at DESC);

CREATE OR REPLACE FUNCTION public.search_conversations(p_query text, p_limit int DEFAULT 30)
RETURNS TABLE (id uuid, account_id uuid, participant_name text, participant_email text, channel text, status text, last_message_at timestamptz, headline text, rank real)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH q AS (SELECT websearch_to_tsquery('english', coalesce(p_query, '')) AS tsq),
  conv_doc AS (
    SELECT c.id, to_tsvector('english', coalesce(c.participant_name,'') || ' ' || coalesce(c.participant_email,'') || ' ' || coalesce(c.ai_summary,'')) AS doc
    FROM public.conversations c
  ),
  msg_match AS (
    SELECT DISTINCT ON (m.conversation_id)
      m.conversation_id,
      to_tsvector('english', coalesce(m.message_text,'') || ' ' || coalesce(m.email_subject,'')) AS doc,
      coalesce(m.message_text, m.email_subject, '') AS body
    FROM public.messages m, q
    WHERE q.tsq IS NOT NULL
      AND to_tsvector('english', coalesce(m.message_text,'') || ' ' || coalesce(m.email_subject,'')) @@ q.tsq
    ORDER BY m.conversation_id,
      ts_rank_cd(to_tsvector('english', coalesce(m.message_text,'') || ' ' || coalesce(m.email_subject,'')), q.tsq) DESC,
      m.timestamp DESC
  )
  SELECT c.id, c.account_id, c.participant_name, c.participant_email, c.channel::text, c.status::text, c.last_message_at,
    ts_headline('english', coalesce(mm.body, c.ai_summary, c.participant_name, ''), q.tsq,
      'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=18, MinWords=5, ShortWord=2') AS headline,
    GREATEST(ts_rank_cd(cd.doc, q.tsq), coalesce(ts_rank_cd(mm.doc, q.tsq), 0)) AS rank
  FROM public.conversations c
  CROSS JOIN q
  JOIN conv_doc cd ON cd.id = c.id
  LEFT JOIN msg_match mm ON mm.conversation_id = c.id
  WHERE q.tsq IS NOT NULL AND c.merged_into_id IS NULL
    AND (is_super_admin() OR c.account_id IN (SELECT a.id FROM public.accounts a WHERE a.company_id = current_user_company_id()))
    AND (cd.doc @@ q.tsq OR mm.conversation_id IS NOT NULL)
  ORDER BY rank DESC, c.last_message_at DESC NULLS LAST
  LIMIT LEAST(GREATEST(coalesce(p_limit, 30), 1), 100);
$$;

GRANT EXECUTE ON FUNCTION public.search_conversations(text, int) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.search_conversations(text, int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.search_conversations(text, int) FROM PUBLIC;
