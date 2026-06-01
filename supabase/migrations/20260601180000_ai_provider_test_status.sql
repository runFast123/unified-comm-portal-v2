-- Per-provider connection health status, written by POST /api/ai-providers/[id]/test
-- and shown as a badge in the AI Settings provider list.
--   last_tested_at : when the connection was last checked
--   last_test_ok   : true = reachable + key valid, false = failed, null = never tested
--   last_test_error: generic (key-safe) failure message for the last check
ALTER TABLE public.ai_providers
  ADD COLUMN IF NOT EXISTS last_tested_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_test_ok boolean,
  ADD COLUMN IF NOT EXISTS last_test_error text;

COMMENT ON COLUMN public.ai_providers.last_tested_at IS
  'When the provider connection was last health-checked via POST /api/ai-providers/[id]/test.';
COMMENT ON COLUMN public.ai_providers.last_test_ok IS
  'Result of the last health check: true=reachable+key valid, false=failed, null=never tested.';
