-- Per-user / per-role AI model assignment (RBAC). Routes a user's AI calls to a
-- specific configured provider instead of the company's active one. Resolution:
-- user assignment -> role assignment -> company active (existing getAIConfig).
-- Empty table = no behavior change.
CREATE TABLE IF NOT EXISTS public.ai_model_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  role text,                                                   -- set => role-level assignment
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,  -- set => user-level assignment
  ai_provider_id uuid NOT NULL REFERENCES public.ai_providers(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT ai_model_assignment_scope CHECK ((role IS NOT NULL) <> (user_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ai_model_assignment_role
  ON public.ai_model_assignments (company_id, role) WHERE role IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ai_model_assignment_user
  ON public.ai_model_assignments (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_model_assignments_company ON public.ai_model_assignments (company_id);

CREATE OR REPLACE FUNCTION public.touch_ai_model_assignments_updated_at() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS ai_model_assignments_touch ON public.ai_model_assignments;
CREATE TRIGGER ai_model_assignments_touch BEFORE UPDATE ON public.ai_model_assignments
  FOR EACH ROW EXECUTE FUNCTION public.touch_ai_model_assignments_updated_at();

ALTER TABLE public.ai_model_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_model_assignments read" ON public.ai_model_assignments;
CREATE POLICY "ai_model_assignments read" ON public.ai_model_assignments
  FOR SELECT TO authenticated USING (
    public.is_super_admin() OR company_id = public.current_user_company_id()
  );
DROP POLICY IF EXISTS "ai_model_assignments insert" ON public.ai_model_assignments;
CREATE POLICY "ai_model_assignments insert" ON public.ai_model_assignments
  FOR INSERT TO authenticated WITH CHECK (
    public.is_super_admin() OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );
DROP POLICY IF EXISTS "ai_model_assignments update" ON public.ai_model_assignments;
CREATE POLICY "ai_model_assignments update" ON public.ai_model_assignments
  FOR UPDATE TO authenticated USING (
    public.is_super_admin() OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  ) WITH CHECK (
    public.is_super_admin() OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );
DROP POLICY IF EXISTS "ai_model_assignments delete" ON public.ai_model_assignments;
CREATE POLICY "ai_model_assignments delete" ON public.ai_model_assignments
  FOR DELETE TO authenticated USING (
    public.is_super_admin() OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_model_assignments TO authenticated;
