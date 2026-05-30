-- kb_articles_validate_account_company() is a BEFORE INSERT/UPDATE trigger
-- function (added in 20260530120000). It should never be callable as a
-- PostgREST RPC by clients. Triggers still fire regardless of EXECUTE grants
-- (they run with the table owner's rights), so revoking EXECUTE is safe and
-- closes the Supabase advisor WARN "anon/authenticated can execute SECURITY
-- DEFINER function via /rest/v1/rpc". Idempotent.
REVOKE EXECUTE ON FUNCTION public.kb_articles_validate_account_company() FROM anon, authenticated, public;
