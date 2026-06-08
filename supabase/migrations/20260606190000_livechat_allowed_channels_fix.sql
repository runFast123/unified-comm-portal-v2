-- FIX: the channel-isolation RLS resolver was missing 'livechat'. The RESTRICTIVE
-- channel_visibility policies on conversations/messages check
-- `channel = ANY(user_allowed_channels())`, so live-chat rows (channel='livechat')
-- failed that check for the authenticated (RLS) client — hiding live-chat
-- conversations from agents in the inbox and blocking client-side writes to them.
-- Add 'livechat' to the baseline so it resolves like every other channel
-- (default-allowed; still gated by the channel:livechat RBAC key for restricted
-- users). Keep this array in sync with the channel registry (CHANNEL_KEYS).
CREATE OR REPLACE FUNCTION public.user_allowed_channels()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH me AS (
    SELECT id, role::text AS role, company_id FROM public.users WHERE id = auth.uid()
  ),
  base AS (
    SELECT unnest(ARRAY['email','teams','whatsapp','sms','telegram','messenger','instagram','livechat']) AS ch
  )
  SELECT
    CASE WHEN public.is_super_admin() THEN (SELECT array_agg(ch) FROM base)
    ELSE (
      SELECT array_agg(b.ch) FROM base b
      WHERE COALESCE(
        (SELECT (up.effect = 'allow') FROM public.user_permissions up
           WHERE up.user_id = (SELECT id FROM me) AND up.permission_key = 'channel:' || b.ch LIMIT 1),
        (SELECT rp.allowed FROM public.role_permissions rp
           WHERE rp.company_id = (SELECT company_id FROM me) AND rp.role = (SELECT role FROM me)
             AND rp.permission_key = 'channel:' || b.ch LIMIT 1),
        (SELECT rp.allowed FROM public.role_permissions rp
           WHERE rp.company_id IS NULL AND rp.role = (SELECT role FROM me)
             AND rp.permission_key = 'channel:' || b.ch LIMIT 1),
        true
      )
    )
    END
$function$;
