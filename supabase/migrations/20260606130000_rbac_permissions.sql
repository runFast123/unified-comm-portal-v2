-- RBAC permissions: role-level defaults (platform-wide + per-company overrides)
-- and per-user overrides. The code baseline (src/lib/permissions/defaults.ts) is
-- the starting point; these tables store SPARSE deltas resolved on top of it.
-- Tenancy mirrors ai_providers: SELECT → super_admin OR platform-default row OR
-- same company; writes → super_admin OR (company admin AND same company).

CREATE TABLE IF NOT EXISTS public.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE, -- NULL = platform default (super_admin only)
  role text NOT NULL,
  permission_key text NOT NULL,
  allowed boolean NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- One row per (scope, role, permission). NULL company_id is the platform scope;
-- COALESCE to a sentinel so all platform rows share one uniqueness domain.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_permissions
  ON public.role_permissions
     (COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), role, permission_key);
CREATE INDEX IF NOT EXISTS idx_role_permissions_lookup
  ON public.role_permissions (role, company_id);

CREATE TABLE IF NOT EXISTS public.user_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  permission_key text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('allow','deny')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_permissions ON public.user_permissions (user_id, permission_key);

CREATE OR REPLACE FUNCTION public.touch_permissions_updated_at() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS role_permissions_touch ON public.role_permissions;
CREATE TRIGGER role_permissions_touch BEFORE UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.touch_permissions_updated_at();
DROP TRIGGER IF EXISTS user_permissions_touch ON public.user_permissions;
CREATE TRIGGER user_permissions_touch BEFORE UPDATE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.touch_permissions_updated_at();

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "role_permissions read" ON public.role_permissions;
CREATE POLICY "role_permissions read" ON public.role_permissions
  FOR SELECT TO authenticated USING (
    public.is_super_admin() OR company_id IS NULL OR company_id = public.current_user_company_id()
  );
DROP POLICY IF EXISTS "role_permissions insert" ON public.role_permissions;
CREATE POLICY "role_permissions insert" ON public.role_permissions
  FOR INSERT TO authenticated WITH CHECK (
    public.is_super_admin() OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );
DROP POLICY IF EXISTS "role_permissions update" ON public.role_permissions;
CREATE POLICY "role_permissions update" ON public.role_permissions
  FOR UPDATE TO authenticated USING (
    public.is_super_admin() OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  ) WITH CHECK (
    public.is_super_admin() OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );
DROP POLICY IF EXISTS "role_permissions delete" ON public.role_permissions;
CREATE POLICY "role_permissions delete" ON public.role_permissions
  FOR DELETE TO authenticated USING (
    public.is_super_admin() OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );

DROP POLICY IF EXISTS "user_permissions read" ON public.user_permissions;
CREATE POLICY "user_permissions read" ON public.user_permissions
  FOR SELECT TO authenticated USING (
    public.is_super_admin() OR EXISTS (
      SELECT 1 FROM public.users u WHERE u.id = user_permissions.user_id AND u.company_id = public.current_user_company_id()
    )
  );
DROP POLICY IF EXISTS "user_permissions insert" ON public.user_permissions;
CREATE POLICY "user_permissions insert" ON public.user_permissions
  FOR INSERT TO authenticated WITH CHECK (
    public.is_super_admin() OR (public.is_company_admin() AND EXISTS (
      SELECT 1 FROM public.users u WHERE u.id = user_permissions.user_id AND u.company_id = public.current_user_company_id()
    ))
  );
DROP POLICY IF EXISTS "user_permissions update" ON public.user_permissions;
CREATE POLICY "user_permissions update" ON public.user_permissions
  FOR UPDATE TO authenticated USING (
    public.is_super_admin() OR (public.is_company_admin() AND EXISTS (
      SELECT 1 FROM public.users u WHERE u.id = user_permissions.user_id AND u.company_id = public.current_user_company_id()
    ))
  ) WITH CHECK (
    public.is_super_admin() OR (public.is_company_admin() AND EXISTS (
      SELECT 1 FROM public.users u WHERE u.id = user_permissions.user_id AND u.company_id = public.current_user_company_id()
    ))
  );
DROP POLICY IF EXISTS "user_permissions delete" ON public.user_permissions;
CREATE POLICY "user_permissions delete" ON public.user_permissions
  FOR DELETE TO authenticated USING (
    public.is_super_admin() OR (public.is_company_admin() AND EXISTS (
      SELECT 1 FROM public.users u WHERE u.id = user_permissions.user_id AND u.company_id = public.current_user_company_id()
    ))
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permissions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_permissions TO authenticated;
