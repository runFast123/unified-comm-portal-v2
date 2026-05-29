-- ============================================================================
-- user_invitations: pre-registration that's inherited on signup.
--
-- Problem this fixes: /api/users/invite tried to INSERT into public.users
-- with no `id`. But public.users.id has NO default — it MUST equal the
-- Supabase Auth user id, which only exists after the person signs up (the
-- `handle_new_auth_user` trigger creates the public.users row keyed by
-- auth.uid). So the raw insert failed with
--   "null value in column id of relation users violates not-null constraint".
--
-- The modal already promised the correct UX: "pre-registers the user with
-- their role and account; when they sign up with the same email they inherit
-- these settings." This migration actually implements that:
--
--   1. A `user_invitations` table keyed by email holds the pre-assigned
--      role + account_id + company_id (NO auth user, NO id problem).
--   2. `handle_new_auth_user` is extended: on signup it looks up a pending
--      invitation by email, applies its role/account/company to the new
--      public.users row, and deletes the invitation. No match → existing
--      default (first user → admin, otherwise viewer).
--
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_invitations (
  email        text PRIMARY KEY,                       -- always stored lowercased
  role         public.user_role NOT NULL DEFAULT 'company_member',
  account_id   uuid REFERENCES public.accounts(id)  ON DELETE SET NULL,
  company_id   uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  full_name    text,
  invited_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_invitations_company ON public.user_invitations (company_id);

CREATE OR REPLACE FUNCTION public.touch_user_invitations_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS user_invitations_touch_updated_at ON public.user_invitations;
CREATE TRIGGER user_invitations_touch_updated_at
  BEFORE UPDATE ON public.user_invitations
  FOR EACH ROW EXECUTE FUNCTION public.touch_user_invitations_updated_at();

-- RLS: super_admin all; company_admin scoped to own company. (All writes
-- actually go through the service-role invite API, but these policies are
-- defence-in-depth + let an admin UI read the pending list directly.)
ALTER TABLE public.user_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invitations_read"   ON public.user_invitations;
DROP POLICY IF EXISTS "invitations_write"  ON public.user_invitations;
DROP POLICY IF EXISTS "invitations_update" ON public.user_invitations;
DROP POLICY IF EXISTS "invitations_delete" ON public.user_invitations;

CREATE POLICY "invitations_read" ON public.user_invitations
  FOR SELECT TO authenticated USING (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );
CREATE POLICY "invitations_write" ON public.user_invitations
  FOR INSERT TO authenticated WITH CHECK (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );
CREATE POLICY "invitations_update" ON public.user_invitations
  FOR UPDATE TO authenticated USING (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  ) WITH CHECK (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );
CREATE POLICY "invitations_delete" ON public.user_invitations
  FOR DELETE TO authenticated USING (
    public.is_super_admin()
    OR (public.is_company_admin() AND company_id = public.current_user_company_id())
  );

-- Extend the signup trigger to consume a matching invitation.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  _is_first boolean;
  _inv public.user_invitations%ROWTYPE;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM public.users) INTO _is_first;

  -- Pending invitation for this email? (emails stored lowercased)
  SELECT * INTO _inv
  FROM public.user_invitations
  WHERE email = lower(NEW.email)
  LIMIT 1;

  IF _inv.email IS NOT NULL THEN
    -- Inherit the pre-assigned role/account/company. The sync_user_company_id
    -- trigger derives company_id from account_id when an account is set;
    -- when only company_id is set (no account), it's preserved on insert.
    INSERT INTO public.users (id, email, role, full_name, account_id, company_id)
    VALUES (
      NEW.id,
      NEW.email,
      _inv.role,
      COALESCE(_inv.full_name, NEW.raw_user_meta_data->>'full_name'),
      _inv.account_id,
      _inv.company_id
    )
    ON CONFLICT (id) DO UPDATE
      SET role       = EXCLUDED.role,
          account_id = EXCLUDED.account_id,
          company_id = EXCLUDED.company_id,
          full_name  = COALESCE(public.users.full_name, EXCLUDED.full_name);

    DELETE FROM public.user_invitations WHERE email = lower(NEW.email);
  ELSE
    INSERT INTO public.users (id, email, role)
    VALUES (
      NEW.id,
      NEW.email,
      CASE WHEN _is_first THEN 'admin'::public.user_role ELSE 'viewer'::public.user_role END
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;
