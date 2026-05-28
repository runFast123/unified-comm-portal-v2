-- ============================================================================
-- Close cross-tenant RLS leak: company-scope every `is_admin()` policy
--
-- Discovered via multi-tenant audit (2026-05-28): every is_admin()-based
-- policy across 8 tables had NO company scoping, so a company_admin from
-- one tenant could read/write/delete another tenant's rows. Confirmed by
-- successfully deleting MCM_Teams.channel_config and writing arbitrary
-- JSON into MCM.email.channel_config.config_data as Acme company_admin.
--
-- Fix pattern: `is_super_admin() OR (is_admin() AND <company-scope>)`.
-- super_admin keeps cross-tenant access; company_admin is bounded.
-- ============================================================================

-- ─── accounts (has company_id directly) ───────────────────────────────
DROP POLICY IF EXISTS "Admins can delete accounts" ON public.accounts;
DROP POLICY IF EXISTS "Admins can insert accounts" ON public.accounts;
DROP POLICY IF EXISTS "Admins can update accounts" ON public.accounts;

CREATE POLICY "Admins can delete accounts in company" ON public.accounts
  FOR DELETE TO authenticated
  USING (is_super_admin() OR (is_admin() AND company_id = current_user_company_id()));

CREATE POLICY "Admins can insert accounts in company" ON public.accounts
  FOR INSERT TO authenticated
  WITH CHECK (is_super_admin() OR (is_admin() AND company_id = current_user_company_id()));

CREATE POLICY "Admins can update accounts in company" ON public.accounts
  FOR UPDATE TO authenticated
  USING (is_super_admin() OR (is_admin() AND company_id = current_user_company_id()))
  WITH CHECK (is_super_admin() OR (is_admin() AND company_id = current_user_company_id()));

-- ─── channel_configs (account_id → accounts.company_id) ───────────────
DROP POLICY IF EXISTS "Admins can delete channel_configs" ON public.channel_configs;
DROP POLICY IF EXISTS "Admins can insert channel_configs" ON public.channel_configs;
DROP POLICY IF EXISTS "Admins can read channel_configs" ON public.channel_configs;
DROP POLICY IF EXISTS "Admins can update channel_configs" ON public.channel_configs;

CREATE POLICY "Admins read channel_configs in company" ON public.channel_configs
  FOR SELECT TO authenticated
  USING (is_super_admin() OR (is_admin() AND account_id IN
    (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())));

CREATE POLICY "Admins insert channel_configs in company" ON public.channel_configs
  FOR INSERT TO authenticated
  WITH CHECK (is_super_admin() OR (is_admin() AND account_id IN
    (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())));

CREATE POLICY "Admins update channel_configs in company" ON public.channel_configs
  FOR UPDATE TO authenticated
  USING (is_super_admin() OR (is_admin() AND account_id IN
    (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())))
  WITH CHECK (is_super_admin() OR (is_admin() AND account_id IN
    (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())));

CREATE POLICY "Admins delete channel_configs in company" ON public.channel_configs
  FOR DELETE TO authenticated
  USING (is_super_admin() OR (is_admin() AND account_id IN
    (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())));

-- ─── notification_rules (account_id → accounts.company_id) ────────────
DROP POLICY IF EXISTS "Admins can delete notification_rules" ON public.notification_rules;
DROP POLICY IF EXISTS "Admins can insert notification_rules" ON public.notification_rules;
DROP POLICY IF EXISTS "Admins can update notification_rules" ON public.notification_rules;

CREATE POLICY "Admins insert notification_rules in company" ON public.notification_rules
  FOR INSERT TO authenticated
  WITH CHECK (is_super_admin() OR (is_admin() AND account_id IN
    (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())));

CREATE POLICY "Admins update notification_rules in company" ON public.notification_rules
  FOR UPDATE TO authenticated
  USING (is_super_admin() OR (is_admin() AND account_id IN
    (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())))
  WITH CHECK (is_super_admin() OR (is_admin() AND account_id IN
    (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())));

CREATE POLICY "Admins delete notification_rules in company" ON public.notification_rules
  FOR DELETE TO authenticated
  USING (is_super_admin() OR (is_admin() AND account_id IN
    (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())));

-- ─── routing_rules (account_id → accounts.company_id) ─────────────────
DROP POLICY IF EXISTS "Admins write routing_rules" ON public.routing_rules;

CREATE POLICY "Admins write routing_rules in company" ON public.routing_rules
  FOR ALL TO authenticated
  USING (is_super_admin() OR (is_admin() AND account_id IN
    (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())))
  WITH CHECK (is_super_admin() OR (is_admin() AND account_id IN
    (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())));

-- ─── integration_settings (portal-wide, super_admin only) ─────────────
-- These rows hold Google/Azure OAuth CLIENT credentials shared across all
-- tenants. A company_admin must NEVER see another tenant's environment —
-- and frankly there's no need for any non-super to ever touch this table.
DROP POLICY IF EXISTS "Admins delete integration_settings" ON public.integration_settings;
DROP POLICY IF EXISTS "Admins read integration_settings" ON public.integration_settings;
DROP POLICY IF EXISTS "Admins update integration_settings" ON public.integration_settings;
DROP POLICY IF EXISTS "Admins write integration_settings" ON public.integration_settings;

CREATE POLICY "Super admins read integration_settings" ON public.integration_settings
  FOR SELECT TO authenticated
  USING (is_super_admin());

CREATE POLICY "Super admins insert integration_settings" ON public.integration_settings
  FOR INSERT TO authenticated
  WITH CHECK (is_super_admin());

CREATE POLICY "Super admins update integration_settings" ON public.integration_settings
  FOR UPDATE TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

CREATE POLICY "Super admins delete integration_settings" ON public.integration_settings
  FOR DELETE TO authenticated
  USING (is_super_admin());

-- ─── metrics_events (portal-wide, super_admin only) ───────────────────
-- Label JSON often embeds account/company identifiers; safest to gate
-- to super_admin entirely. Per-tenant metrics views can be added via
-- views with explicit company filters if a use case appears.
DROP POLICY IF EXISTS "Admins read metrics" ON public.metrics_events;

CREATE POLICY "Super admins read metrics" ON public.metrics_events
  FOR SELECT TO authenticated
  USING (is_super_admin());

-- ─── note_mentions (mentioned_user_id self-scope; remove admin bypass) ─
-- Users see their own mentions. Removing the broad is_admin() bypass
-- since cross-tenant admin visibility into mentions isn't a feature.
DROP POLICY IF EXISTS "Users see own mentions" ON public.note_mentions;
DROP POLICY IF EXISTS "Users mark own mentions read" ON public.note_mentions;

CREATE POLICY "Users see own mentions" ON public.note_mentions
  FOR SELECT TO authenticated
  USING (mentioned_user_id = (SELECT auth.uid()) OR is_super_admin());

CREATE POLICY "Users mark own mentions read" ON public.note_mentions
  FOR UPDATE TO authenticated
  USING (mentioned_user_id = (SELECT auth.uid()))
  WITH CHECK (mentioned_user_id = (SELECT auth.uid()));

-- ─── saved_views (user_id self-scope; admin bypass scoped by company) ──
-- A company_admin should see shared saved_views WITHIN their company,
-- not cross-tenant.
DROP POLICY IF EXISTS "Users read own + shared saved_views" ON public.saved_views;
DROP POLICY IF EXISTS "Users write own saved_views" ON public.saved_views;

CREATE POLICY "Users read own + shared saved_views" ON public.saved_views
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR is_super_admin()
    OR (
      is_shared = true
      AND user_id IN (SELECT id FROM public.users WHERE company_id = current_user_company_id())
    )
    OR (
      is_admin()
      AND user_id IN (SELECT id FROM public.users WHERE company_id = current_user_company_id())
    )
  );

CREATE POLICY "Users write own saved_views" ON public.saved_views
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) OR is_super_admin())
  WITH CHECK (user_id = (SELECT auth.uid()) OR is_super_admin());
