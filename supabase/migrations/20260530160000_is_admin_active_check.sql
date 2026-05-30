-- Power-model consistency fix. is_admin() was the only role helper WITHOUT an
-- is_active check (is_super_admin / is_company_admin / is_supervisor all have
-- `AND COALESCE(is_active, true)`). is_admin() gates write policies on accounts,
-- ai_config, channel_configs, notification_rules, routing_rules and the
-- audit_log read — so a DEACTIVATED admin could still modify those tables.
-- Deactivating a user must revoke ALL their power; this aligns is_admin() with
-- the rest. (With the active check it is now equivalent to is_company_admin.)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('admin'::user_role, 'super_admin'::user_role, 'company_admin'::user_role)
      AND COALESCE(is_active, true)
  );
$$;
