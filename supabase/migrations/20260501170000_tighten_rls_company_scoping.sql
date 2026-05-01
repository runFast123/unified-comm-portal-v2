-- ─────────────────────────────────────────────────────────────────────────
-- Tighten RLS to company-scope every leaking table.
--
-- Audit revealed that several tables had `USING (true)` policies, meaning
-- ANY authenticated user (regardless of company) could read/write that
-- table's contents. With multi-tenancy now in place, this was a real
-- cross-tenant data exposure on:
--
--   users (SELECT)               — leaked user list across companies
--   contacts (ALL)               — leaked customer profiles
--   conversation_notes (ALL)     — leaked internal team notes
--   kb_articles (ALL)            — leaked knowledge base content
--   kb_hits (read+insert)        — leaked AI retrieval analytics
--   google_sheets_sync (ALL)     — leaked sheet integration config
--   imported_records (read+insert) — leaked imported customer data
--   notification_rules (SELECT)  — leaked Slack webhook URLs + email recipients
--   message_classifications (write) — anyone could write classifications
--   routing_rules (SELECT)       — leaked routing config across companies
--
-- Plus:
--   users (UPDATE/DELETE) hardcoded `role = 'admin'`, which excluded
--   super_admin and company_admin. Replaced with the is_admin() / is_company_admin()
--   helpers so the new role hierarchy is honored.
--
-- Every replacement preserves super_admin bypass + company-scoped access.
-- Idempotent (DROP IF EXISTS before CREATE).
-- ─────────────────────────────────────────────────────────────────────────

-- ─── users ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can read users" ON public.users;
CREATE POLICY "Users read same-company users" ON public.users
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR id = auth.uid()
    OR (company_id IS NOT NULL AND company_id = current_user_company_id())
  );

DROP POLICY IF EXISTS "Admins can update any user" ON public.users;
CREATE POLICY "Admins update users in scope" ON public.users
  FOR UPDATE TO authenticated
  USING (
    id = auth.uid()
    OR is_super_admin()
    OR (is_company_admin() AND company_id = current_user_company_id())
  )
  WITH CHECK (
    id = auth.uid()
    OR is_super_admin()
    OR (is_company_admin() AND company_id = current_user_company_id())
  );

DROP POLICY IF EXISTS "Admins can delete users" ON public.users;
CREATE POLICY "Admins delete users in scope" ON public.users
  FOR DELETE TO authenticated USING (
    is_super_admin()
    OR (is_company_admin() AND company_id = current_user_company_id())
  );

-- ─── contacts ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated read contacts" ON public.contacts;
DROP POLICY IF EXISTS "Authenticated write contacts" ON public.contacts;

CREATE POLICY "Read contacts in own company" ON public.contacts
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.contact_id = contacts.id
        AND c.account_id IN (
          SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
        )
    )
  );
CREATE POLICY "Admins write contacts" ON public.contacts
  FOR INSERT TO authenticated WITH CHECK (
    is_super_admin() OR is_company_admin()
  );
CREATE POLICY "Admins update contacts" ON public.contacts
  FOR UPDATE TO authenticated
  USING (is_super_admin() OR is_company_admin())
  WITH CHECK (is_super_admin() OR is_company_admin());
CREATE POLICY "Admins delete contacts" ON public.contacts
  FOR DELETE TO authenticated USING (
    is_super_admin() OR is_company_admin()
  );

-- ─── conversation_notes ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated read notes" ON public.conversation_notes;
DROP POLICY IF EXISTS "Authenticated insert notes" ON public.conversation_notes;
DROP POLICY IF EXISTS "Authenticated update notes" ON public.conversation_notes;
DROP POLICY IF EXISTS "Authenticated delete notes" ON public.conversation_notes;

CREATE POLICY "Read notes in own company" ON public.conversation_notes
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_notes.conversation_id
        AND c.account_id IN (
          SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
        )
    )
  );
CREATE POLICY "Write notes in own company" ON public.conversation_notes
  FOR INSERT TO authenticated WITH CHECK (
    is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_notes.conversation_id
        AND c.account_id IN (
          SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
        )
    )
  );
CREATE POLICY "Update own notes" ON public.conversation_notes
  FOR UPDATE TO authenticated
  USING (
    is_super_admin()
    OR (
      author_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.id = conversation_notes.conversation_id
          AND c.account_id IN (
            SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
          )
      )
    )
  )
  WITH CHECK (
    is_super_admin()
    OR (
      author_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.id = conversation_notes.conversation_id
          AND c.account_id IN (
            SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
          )
      )
    )
  );
CREATE POLICY "Delete own notes or admin in scope" ON public.conversation_notes
  FOR DELETE TO authenticated USING (
    is_super_admin()
    OR (
      (author_id = auth.uid() OR is_company_admin())
      AND EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.id = conversation_notes.conversation_id
          AND c.account_id IN (
            SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
          )
      )
    )
  );

-- ─── kb_articles ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can read kb_articles" ON public.kb_articles;
DROP POLICY IF EXISTS "Authenticated users can insert kb_articles" ON public.kb_articles;
DROP POLICY IF EXISTS "Authenticated users can update kb_articles" ON public.kb_articles;

CREATE POLICY "Read kb_articles in own company" ON public.kb_articles
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR account_id IN (
      SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
    )
  );
CREATE POLICY "Admins manage kb_articles in scope" ON public.kb_articles
  FOR ALL TO authenticated
  USING (
    is_super_admin()
    OR (is_company_admin() AND account_id IN (
      SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
    ))
  )
  WITH CHECK (
    is_super_admin()
    OR (is_company_admin() AND account_id IN (
      SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
    ))
  );

-- ─── kb_hits ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can read kb_hits" ON public.kb_hits;
DROP POLICY IF EXISTS "Authenticated users can insert kb_hits" ON public.kb_hits;

CREATE POLICY "Read kb_hits in own company" ON public.kb_hits
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.kb_articles ka
      WHERE ka.id = kb_hits.kb_article_id
        AND ka.account_id IN (
          SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
        )
    )
  );
CREATE POLICY "Admins insert kb_hits" ON public.kb_hits
  FOR INSERT TO authenticated WITH CHECK (
    is_super_admin() OR is_company_admin()
  );

-- ─── google_sheets_sync ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can read google_sheets_sync" ON public.google_sheets_sync;
DROP POLICY IF EXISTS "Authenticated users can insert google_sheets_sync" ON public.google_sheets_sync;
DROP POLICY IF EXISTS "Authenticated users can update google_sheets_sync" ON public.google_sheets_sync;

CREATE POLICY "Read sheets_sync in own company" ON public.google_sheets_sync
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR account_id IN (
      SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
    )
  );
CREATE POLICY "Admins manage sheets_sync in scope" ON public.google_sheets_sync
  FOR ALL TO authenticated
  USING (
    is_super_admin()
    OR (is_company_admin() AND account_id IN (
      SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
    ))
  )
  WITH CHECK (
    is_super_admin()
    OR (is_company_admin() AND account_id IN (
      SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
    ))
  );

-- ─── imported_records ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can read imported_records" ON public.imported_records;
DROP POLICY IF EXISTS "Authenticated users can insert imported_records" ON public.imported_records;

CREATE POLICY "Read imported_records in own company" ON public.imported_records
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR account_id IN (
      SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
    )
  );
CREATE POLICY "Insert imported_records in own company" ON public.imported_records
  FOR INSERT TO authenticated WITH CHECK (
    is_super_admin()
    OR account_id IN (
      SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
    )
  );

-- ─── notification_rules SELECT ───────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can read notification_rules" ON public.notification_rules;

CREATE POLICY "Read notification_rules in own company" ON public.notification_rules
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR account_id IN (
      SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
    )
  );

-- ─── message_classifications INSERT/UPDATE ───────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can insert message_classifications" ON public.message_classifications;
DROP POLICY IF EXISTS "Authenticated users can update message_classifications" ON public.message_classifications;

CREATE POLICY "Admins insert message_classifications" ON public.message_classifications
  FOR INSERT TO authenticated WITH CHECK (
    is_super_admin() OR is_company_admin()
  );
CREATE POLICY "Admins update message_classifications" ON public.message_classifications
  FOR UPDATE TO authenticated
  USING (is_super_admin() OR is_company_admin())
  WITH CHECK (is_super_admin() OR is_company_admin());

-- ─── routing_rules SELECT ────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated read routing_rules" ON public.routing_rules;
CREATE POLICY "Read routing_rules in own company" ON public.routing_rules
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR account_id IS NULL  -- global rules visible to everyone in their own company list
    OR account_id IN (
      SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
    )
  );
