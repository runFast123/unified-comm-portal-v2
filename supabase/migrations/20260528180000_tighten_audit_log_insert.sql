-- audit_log INSERT was `WITH CHECK (true)` — any authenticated user could
-- insert a row attributed to a different user_id or company_id. Tighten to
-- "the row's user_id must match the caller (or caller is super_admin, for
-- service-role-style writes from server code running as a user)".
DROP POLICY IF EXISTS "Authenticated users can insert audit_log" ON public.audit_log;
CREATE POLICY "Users can only insert audit_log attributed to themselves"
  ON public.audit_log FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    OR is_super_admin()
  );
