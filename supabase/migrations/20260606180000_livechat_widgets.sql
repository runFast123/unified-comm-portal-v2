-- Embeddable live-chat widget config. One widget per account (a channel_type=
-- 'livechat' account). widget_key is the PUBLIC token in the embed snippet; the
-- unauthenticated widget endpoints look the account up by it (via service-role).
-- Appearance (title/color/welcome) is public too. No secrets here.
CREATE TABLE IF NOT EXISTS public.livechat_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL UNIQUE REFERENCES public.accounts(id) ON DELETE CASCADE,
  widget_key text NOT NULL UNIQUE,
  title text NOT NULL DEFAULT 'Chat with us',
  color text NOT NULL DEFAULT '#16a34a',
  welcome_message text NOT NULL DEFAULT 'Hi! How can we help you today?',
  is_enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_livechat_widgets_widget_key ON public.livechat_widgets (widget_key);

CREATE OR REPLACE FUNCTION public.touch_livechat_widgets_updated_at() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS livechat_widgets_touch ON public.livechat_widgets;
CREATE TRIGGER livechat_widgets_touch BEFORE UPDATE ON public.livechat_widgets
  FOR EACH ROW EXECUTE FUNCTION public.touch_livechat_widgets_updated_at();

ALTER TABLE public.livechat_widgets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "livechat_widgets read" ON public.livechat_widgets;
CREATE POLICY "livechat_widgets read" ON public.livechat_widgets
  FOR SELECT TO authenticated USING (
    public.is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = public.current_user_company_id())
  );
DROP POLICY IF EXISTS "livechat_widgets insert" ON public.livechat_widgets;
CREATE POLICY "livechat_widgets insert" ON public.livechat_widgets
  FOR INSERT TO authenticated WITH CHECK (
    public.is_super_admin()
    OR (public.is_company_admin() AND account_id IN (SELECT id FROM public.accounts WHERE company_id = public.current_user_company_id()))
  );
DROP POLICY IF EXISTS "livechat_widgets update" ON public.livechat_widgets;
CREATE POLICY "livechat_widgets update" ON public.livechat_widgets
  FOR UPDATE TO authenticated USING (
    public.is_super_admin()
    OR (public.is_company_admin() AND account_id IN (SELECT id FROM public.accounts WHERE company_id = public.current_user_company_id()))
  ) WITH CHECK (
    public.is_super_admin()
    OR (public.is_company_admin() AND account_id IN (SELECT id FROM public.accounts WHERE company_id = public.current_user_company_id()))
  );
DROP POLICY IF EXISTS "livechat_widgets delete" ON public.livechat_widgets;
CREATE POLICY "livechat_widgets delete" ON public.livechat_widgets
  FOR DELETE TO authenticated USING (
    public.is_super_admin()
    OR (public.is_company_admin() AND account_id IN (SELECT id FROM public.accounts WHERE company_id = public.current_user_company_id()))
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON public.livechat_widgets TO authenticated;
