-- ============================================================================
-- Widen scheduled_messages.status CHECK to cover the full dispatch lifecycle.
--
-- BUG (pre-existing, live in prod)
--   The dispatch-scheduled cron claims a queued reply with a compare-and-set:
--     UPDATE scheduled_messages SET status='dispatching' WHERE status='pending'
--   (src/app/api/cron/dispatch-scheduled/route.ts ~line 186). The live
--   constraint
--     status_values CHECK (status = ANY (ARRAY['pending','sent','cancelled','failed']))
--   does NOT permit 'dispatching', so every claim raised a check_violation
--   (Postgres 23514). The cron treated the row as failed (claimErr branch) and
--   left it 'pending' forever -> queued scheduled replies were NEVER dispatched.
--   (The parallel pending_sends path was unaffected: pending_sends has no such
--   constraint, so its 'sending' claim succeeds.)
--
-- LATENT BUG (newer code, masked by the one above)
--   The retry endpoint's op='dismiss' sets status='dismissed'
--   (src/app/api/scheduled-messages/retry/route.ts ~line 86). The same
--   constraint rejects 'dismissed', so dismissing a FAILED scheduled_message
--   returns HTTP 500. It could not be hit only because the bug above prevented
--   any scheduled_messages row from ever reaching status='failed'. Fixing the
--   bug above makes this one immediately reachable.
--
-- FIX
--   Replace the constraint with a strict SUPERSET covering every status value
--   the application actually writes. Because the new set is a superset of the
--   previously enforced set, all existing rows already satisfy it (and no row
--   could ever have been stored as 'dispatching'/'dismissed' — the old
--   constraint rejected them), so the re-validation on ADD cannot fail.
--
--   scheduled_messages lifecycle (verified against every writer in src/):
--     pending      api/scheduled-messages POST (insert); retry op='retry'
--     dispatching  cron claim: pending -> dispatching
--     sent         cron success
--     failed       cron send failure
--     cancelled    api/scheduled-messages/[id] DELETE (cancel while pending)
--     dismissed    retry op='dismiss' (hide a failed row from the banner)
--
-- Idempotent (DROP ... IF EXISTS + ADD); safe to re-apply.
-- ============================================================================

ALTER TABLE public.scheduled_messages DROP CONSTRAINT IF EXISTS status_values;

ALTER TABLE public.scheduled_messages
  ADD CONSTRAINT status_values
  CHECK (status = ANY (ARRAY['pending','dispatching','sent','cancelled','failed','dismissed']));

COMMENT ON COLUMN public.scheduled_messages.status IS
  'pending | dispatching | sent | cancelled | failed | dismissed';

-- ── Consistency guard on pending_sends (optional, defensive) ────────────────
-- pending_sends has NO status CHECK today, so its 'sending'/'failed'/'dismissed'
-- writes succeed silently. That asymmetry is precisely what let the
-- scheduled_messages bug above hide for so long (the same status-set drift was
-- caught on one table and not the other). Add a matching guard so an unknown
-- status can never slip into either table going forward.
--
--   pending_sends lifecycle (verified against every writer in src/):
--     pending      api/send (insert, delay_ms > 0); retry op='retry'
--     sending      cron claim: pending -> sending   (cf. 'dispatching' above)
--     sent         cron success
--     failed       cron send failure
--     cancelled    api/send/cancel (Undo while pending)
--     dismissed    retry op='dismiss'
--
-- Added NOT VALID: this table never had a constraint, and the existing rows
-- cannot be pre-scanned from the migration author's environment. NOT VALID
-- enforces the guard on every NEW insert/update without risking a failure on a
-- legacy/stray row. Once you've confirmed no out-of-set rows exist, finish with:
--     ALTER TABLE public.pending_sends VALIDATE CONSTRAINT pending_sends_status_values;
ALTER TABLE public.pending_sends DROP CONSTRAINT IF EXISTS pending_sends_status_values;

ALTER TABLE public.pending_sends
  ADD CONSTRAINT pending_sends_status_values
  CHECK (status = ANY (ARRAY['pending','sending','sent','cancelled','failed','dismissed'])) NOT VALID;

COMMENT ON COLUMN public.pending_sends.status IS
  'pending | sending | sent | cancelled | failed | dismissed';
