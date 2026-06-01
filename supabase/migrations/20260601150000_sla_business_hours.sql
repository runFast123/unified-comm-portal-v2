-- ============================================================================
-- SLA business-hours support for auto-escalation.
--
-- Adds an OPTIONAL per-company `business_hours` config so the SLA cron
-- (src/app/api/sla-check/route.ts) can measure the critical-hours breach in
-- *business time* rather than wall-clock time. This is industry standard:
-- a ticket that arrives Friday 5pm should not be "4 business hours" overdue
-- by Saturday 9am when the support desk was closed all weekend.
--
-- Backward compatibility is the contract here:
--   * An ABSENT column value (NULL) means 24/7 — i.e. the helper treats the
--     company as always open and business-time == wall-clock time. This
--     PRESERVES today's behavior exactly for every existing company, since
--     none have a value set.
--
-- Shape of the jsonb value (documented, not enforced — kept flexible so the
-- admin UI / API can evolve without a schema migration):
--   {
--     "timezone": "America/New_York",   -- IANA zone name (string, required)
--     "days": {
--       "mon": [9, 17],   -- [openHour, closeHour] in local time, 24h clock
--       "tue": [9, 17],
--       "wed": [9, 17],
--       "thu": [9, 17],
--       "fri": [9, 17],
--       "sat": null,      -- null (or key absent) = closed all day
--       "sun": null
--     }
--   }
-- Semantics (see src/lib/business-hours.ts for the authoritative impl):
--   * Day keys are lowercase 3-letter ("mon".."sun").
--   * A day mapped to null, missing, or a malformed window = CLOSED that day.
--   * Hours are a single contiguous window [open, close) per day in the
--     configured IANA timezone; open==close or open>close = closed.
--   * The whole column NULL (or not an object / missing "timezone") = 24/7.
--
-- No RLS change: `companies` already has its SELECT/manage policies
-- (see 20260425052349_companies.sql). This is a purely additive nullable
-- column, readable/writable under the existing company policies, and the
-- service-role SLA cron bypasses RLS as it does today.
-- ============================================================================

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS business_hours jsonb;

COMMENT ON COLUMN public.companies.business_hours IS
  'Optional SLA business-hours window. Shape: { timezone: <IANA string>, days: { mon:[openHour,closeHour], ... sun: null } } where a null/missing day = closed and an ABSENT column (NULL) = 24/7 (preserves pre-business-hours behavior). Hours are a single contiguous [open,close) window per day in the configured timezone. Consumed by src/lib/business-hours.ts + the SLA auto-escalation cron.';
