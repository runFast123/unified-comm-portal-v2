-- ============================================================================
-- SLA auto-escalation columns for `accounts`.
--
-- These three per-account columns were referenced across the codebase for a
-- long time but were NEVER migrated into the database:
--   * src/types/database.ts            -> Account.sla_warning_hours / sla_critical_hours / sla_auto_escalate
--   * src/app/api/sla-check/route.ts   -> SELECT id, sla_critical_hours, sla_auto_escalate, ...
--   * src/app/(dashboard)/admin/accounts/page.tsx -> SLA Settings UI (reads + writes all three)
--
-- Because the columns did not exist, the SLA auto-escalation cron degraded to a
-- healthy no-op (the route treats a 42703 "column does not exist" error as
-- "feature not configured"). This migration provisions the feature for real.
--
-- SAFETY CONTRACT — nothing escalates until an admin opts in per account:
--   * `sla_auto_escalate` is NOT NULL DEFAULT false. Adding it backfills every
--     existing account to FALSE, so enabling these columns changes NO behavior
--     until an admin flips the per-account "Auto-Escalate" toggle in
--     /admin/accounts. This is the critical default.
--   * `sla_critical_hours` DEFAULT 4 mirrors the cron's runtime fallback
--     (`account.sla_critical_hours ?? 4`) so an opted-in account with no
--     explicit value behaves identically to the code's documented default.
--   * `sla_warning_hours` is the amber/"approaching breach" UI threshold only
--     (it is NOT read by the escalation cron). Left nullable with no default;
--     the admin UI supplies a value on save and reads it defensively (`?? 2`).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) to match the repo's migration style and
-- so re-applying against an environment that was hand-patched is a safe no-op.
--
-- No RLS change required: `accounts` already has its company-scoped SELECT /
-- manage policies; these are purely additive columns covered by them, and the
-- service-role SLA cron bypasses RLS as it does today.
-- ============================================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS sla_warning_hours  integer,
  ADD COLUMN IF NOT EXISTS sla_critical_hours integer DEFAULT 4,
  ADD COLUMN IF NOT EXISTS sla_auto_escalate  boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.accounts.sla_warning_hours IS
  'Amber "approaching SLA breach" threshold in hours, used by the inbox UI only (NOT the escalation cron). Nullable; the admin UI defaults the field to 2 when unset.';

COMMENT ON COLUMN public.accounts.sla_critical_hours IS
  'Hours of (business-time) inactivity after which an unanswered inbound is considered an SLA breach. Consumed by src/app/api/sla-check/route.ts; DEFAULT 4 mirrors the code fallback (sla_critical_hours ?? 4).';

COMMENT ON COLUMN public.accounts.sla_auto_escalate IS
  'Per-account opt-in master switch for SLA auto-escalation. NOT NULL DEFAULT false so NOTHING auto-escalates until an admin enables it in /admin/accounts. Read by the sla-check cron.';
