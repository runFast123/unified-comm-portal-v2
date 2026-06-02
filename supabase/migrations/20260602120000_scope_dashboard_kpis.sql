-- get_dashboard_kpis() was SECURITY DEFINER (bypasses RLS) and counted
-- messages / ai_replies across EVERY company with no tenant filter, while being
-- EXECUTE-able by the `authenticated` role. Effects:
--   1. Cross-tenant aggregate leak: any signed-in user could call the RPC
--      directly and read platform-wide counts.
--   2. Correctness bug: the dashboard uses avg_response_time_mins from this
--      function, so every tenant saw the same GLOBAL average response time.
-- Fix: scope all four aggregates to the caller's company (via account_id ->
-- accounts.company_id), with a super_admin bypass for the platform-wide view.
-- messages and ai_replies both carry account_id directly, so the scope is a
-- simple IN (caller's accounts). auth.uid()-based helpers resolve the CALLER
-- even inside SECURITY DEFINER (same pattern as search_conversations).
CREATE OR REPLACE FUNCTION public.get_dashboard_kpis()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _total_messages bigint;
  _pending_replies bigint;
  _ai_replies_sent bigint;
  _avg_response_mins numeric;
  _is_super boolean := is_super_admin();
  _company uuid := current_user_company_id();
BEGIN
  SELECT count(*) INTO _total_messages
    FROM messages
    WHERE received_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
      AND (_is_super OR account_id IN (SELECT a.id FROM accounts a WHERE a.company_id = _company));

  SELECT count(*) INTO _pending_replies
    FROM ai_replies
    WHERE status = 'pending_approval'
      AND (_is_super OR account_id IN (SELECT a.id FROM accounts a WHERE a.company_id = _company));

  SELECT count(*) INTO _ai_replies_sent
    FROM ai_replies
    WHERE status = 'sent'
      AND sent_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
      AND (_is_super OR account_id IN (SELECT a.id FROM accounts a WHERE a.company_id = _company));

  SELECT coalesce(round(avg(EXTRACT(EPOCH FROM (ar.sent_at - m.received_at)) / 60.0), 1), 0)
    INTO _avg_response_mins
    FROM ai_replies ar
    JOIN messages m ON m.id = ar.message_id
    WHERE ar.status = 'sent'
      AND ar.sent_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
      AND (_is_super OR ar.account_id IN (SELECT a.id FROM accounts a WHERE a.company_id = _company));

  RETURN json_build_object(
    'total_messages_today', _total_messages,
    'pending_replies', _pending_replies,
    'ai_replies_sent_today', _ai_replies_sent,
    'avg_response_time_mins', _avg_response_mins
  );
END;
$function$;
