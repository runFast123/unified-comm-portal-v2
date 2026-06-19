-- Per-company data-retention window. NULL = disabled (the default → no purge),
-- so this column is INERT until a company opts in. When set (the app enforces a
-- >= 30 day floor), the retention-purge cron deletes that company's
-- resolved/archived conversations (cascading to messages + all related rows)
-- whose last activity is older than retention_days. Active work
-- (active/in_progress/waiting_on_customer/escalated) is NEVER purged.
--
-- Applied to prod via the Supabase MCP on 2026-06-13.
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS retention_days integer;

COMMENT ON COLUMN public.companies.retention_days IS 'Data-retention window in days. NULL = disabled (default, no purge). When set (>= 30), the retention-purge cron hard-deletes resolved/archived conversations (cascade) whose last activity is older than this many days. Active conversations are never purged.';
