-- Performance: wrap every per-row `auth.uid()` call in RLS policies as
-- `(select auth.uid())` so Postgres evaluates it ONCE per statement (initplan)
-- instead of once per row (the Supabase `auth_rls_initplan` advisor). This is a
-- pure, semantics-preserving hoist — the predicate logic is byte-identical, only
-- the auth.uid() token is wrapped. Applied via ALTER POLICY (atomic; the policy
-- is never dropped, so there is no window where the table is unprotected).
-- Helper calls (is_super_admin(), current_user_company_id(), is_company_admin())
-- are left as-is — they are not flagged and rewriting them would add risk.
-- Verified: all 9 policies hoisted, all auth_rls_initplan advisor warnings cleared.

-- ── public.users ──
ALTER POLICY "Users can update own profile" ON public.users
  USING ((id = (select auth.uid())))
  WITH CHECK ((id = (select auth.uid())));

ALTER POLICY "Users can insert own profile" ON public.users
  WITH CHECK ((id = (select auth.uid())));

ALTER POLICY "Users read same-company users" ON public.users
  USING ((is_super_admin() OR (id = (select auth.uid())) OR ((company_id IS NOT NULL) AND (company_id = current_user_company_id()))));

ALTER POLICY "Admins update users in scope" ON public.users
  USING (((id = (select auth.uid())) OR is_super_admin() OR (is_company_admin() AND (company_id = current_user_company_id()))))
  WITH CHECK (((id = (select auth.uid())) OR is_super_admin() OR (is_company_admin() AND (company_id = current_user_company_id()))));

-- ── public.conversation_time_entries ──
ALTER POLICY "time_entries_read" ON public.conversation_time_entries
  USING ((is_super_admin() OR (user_id = (select auth.uid())) OR (is_company_admin() AND (account_id IN ( SELECT accounts.id FROM accounts WHERE (accounts.company_id = current_user_company_id()))))));

ALTER POLICY "time_entries_update" ON public.conversation_time_entries
  USING ((user_id = (select auth.uid())))
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY "time_entries_write" ON public.conversation_time_entries
  WITH CHECK ((user_id = (select auth.uid())));

-- ── public.conversation_notes ──
ALTER POLICY "Update own notes" ON public.conversation_notes
  USING ((is_super_admin() OR ((author_id = (select auth.uid())) AND (EXISTS ( SELECT 1 FROM conversations c WHERE ((c.id = conversation_notes.conversation_id) AND (c.account_id IN ( SELECT accounts.id FROM accounts WHERE (accounts.company_id = current_user_company_id())))))))))
  WITH CHECK ((is_super_admin() OR ((author_id = (select auth.uid())) AND (EXISTS ( SELECT 1 FROM conversations c WHERE ((c.id = conversation_notes.conversation_id) AND (c.account_id IN ( SELECT accounts.id FROM accounts WHERE (accounts.company_id = current_user_company_id())))))))));

ALTER POLICY "Delete own notes or admin in scope" ON public.conversation_notes
  USING ((is_super_admin() OR (((author_id = (select auth.uid())) OR is_company_admin()) AND (EXISTS ( SELECT 1 FROM conversations c WHERE ((c.id = conversation_notes.conversation_id) AND (c.account_id IN ( SELECT accounts.id FROM accounts WHERE (accounts.company_id = current_user_company_id())))))))));
