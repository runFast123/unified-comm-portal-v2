-- ============================================================================
-- Claim tracking for the scheduled-send pipeline, so stranded claims can be
-- reaped instead of sitting in the queue forever.
--
-- BUG (pre-existing, live in prod)
--   dispatch-scheduled claims a queued reply with a compare-and-set:
--     scheduled_messages: UPDATE ... SET status='dispatching' WHERE status='pending'
--     pending_sends:      UPDATE ... SET status='sending'     WHERE status='pending'
--   and only writes a terminal status (sent/failed) once the send resolves. If
--   the function dies in between -- timeout, OOM, deploy mid-flight, crash --
--   the row keeps the claim status FOREVER:
--     * the dispatcher never re-picks it (it selects status='pending')
--     * the retry endpoint refuses it  (it requires status='failed', returning
--       "Cannot retry a message with status='dispatching'")
--   so the reply is silently never sent and only a manual DB write recovers it.
--
-- FIX (this migration + src/lib/dispatch-reaper.ts)
--   Give every queue row the two facts a reaper needs:
--     claimed_at    when the dispatcher took the claim -> how long it has been
--                   held, which is the ONLY safe way to tell "stranded" from
--                   "in flight right now" (see the SAFETY note below)
--     attempt_count how many dispatch attempts this row has burned -> lets a
--                   poison row (one that strands the function every time) be
--                   retired to 'failed' instead of looping forever
--   The garbage-collect cron (*/5) then reclaims stale claims back to 'pending',
--   or to 'failed' once the attempt budget is spent -- which lights up the
--   existing failure banner + agent alerting instead of failing silently.
--
-- SAFETY: why claimed_at and not scheduled_for/send_at
--   scheduled_for/send_at say when a row became DUE, not when it was CLAIMED.
--   Those are the same thing only when the queue is keeping up. Drain a backlog
--   (cron outage, big burst) and rows due hours ago get claimed right now --
--   under a due-time proxy every one of them looks stale the instant it is
--   claimed, so the reaper would yank live in-flight sends back to 'pending'
--   and the next run would send them AGAIN. A double-send to a customer is
--   worse than the stranding this fixes. claimed_at is exact; the reaper
--   no-ops rather than guess when it is absent.
--
-- No status CHECK changes needed: 20260613120000 already widened both tables to
-- the full lifecycle, and this migration introduces no new status values.
--
-- Idempotent (IF NOT EXISTS everywhere); safe to re-apply.
-- ============================================================================

-- ── Columns ─────────────────────────────────────────────────────────────────
-- Both are additive and nullable/defaulted, so code that predates them keeps
-- working: an INSERT that omits them still satisfies every constraint.
-- attempt_count gets a non-volatile DEFAULT, so on PG11+ this is a metadata-only
-- change -- no table rewrite, no long lock, regardless of table size.

ALTER TABLE public.scheduled_messages
  ADD COLUMN IF NOT EXISTS claimed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.pending_sends
  ADD COLUMN IF NOT EXISTS claimed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.scheduled_messages.claimed_at IS
  'When the dispatch cron CASed this row pending -> dispatching. NULL unless a claim is currently held. The reaper (garbage-collect cron) treats a claim older than STALE_CLAIM_THRESHOLD_MS as stranded.';
COMMENT ON COLUMN public.scheduled_messages.attempt_count IS
  'Dispatch attempts burned since the last terminal outcome. Incremented by the cron claim, reset to 0 on every write to sent/failed. The reaper retires a row to failed once it exceeds MAX_DISPATCH_ATTEMPTS so a poison row cannot loop forever.';
COMMENT ON COLUMN public.pending_sends.claimed_at IS
  'When the dispatch cron CASed this row pending -> sending. NULL unless a claim is currently held. See scheduled_messages.claimed_at.';
COMMENT ON COLUMN public.pending_sends.attempt_count IS
  'Dispatch attempts burned since the last terminal outcome. See scheduled_messages.attempt_count.';

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Partial, matching the reaper's exact query shape
--   WHERE status = <claim status> AND claimed_at <= <cutoff>
-- so they stay tiny: only rows with a claim currently held are indexed, which
-- in a healthy queue is a handful of rows at any instant (and zero at rest).

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_stale_claim
  ON public.scheduled_messages (claimed_at)
  WHERE status = 'dispatching';

CREATE INDEX IF NOT EXISTS idx_pending_sends_stale_claim
  ON public.pending_sends (claimed_at)
  WHERE status = 'sending';

-- ── Heal the rows this bug already stranded ─────────────────────────────────
-- Any row sitting in a claim status right now was stranded by the bug above:
-- the dispatcher has been unable to re-pick it and the retry endpoint has been
-- refusing it, for as long as it has been there. They predate claimed_at, so
-- they would be invisible to the reaper (claimed_at IS NULL never matches
-- `claimed_at <= cutoff`) and would stay stuck forever even after this lands.
--
-- Backfill claimed_at from the due time to make them eligible. Using the due
-- time as the claim time is exactly the proxy the SAFETY note rejects for the
-- live path -- it is sound HERE precisely because these rows are known-stranded
-- rather than possibly-in-flight: no function is running for them. The reaper
-- re-queues them on its next pass (or retires them to failed once they exhaust
-- their attempts, surfacing them on the failure banner).
--
-- SAFE TO RE-RUN, and worth re-running once the matching code is deployed: if
-- the deploy lands after this migration, any row stranded by the still-running
-- old dispatcher in that gap also has claimed_at IS NULL, and these two
-- statements sweep it up.

UPDATE public.scheduled_messages
   SET claimed_at = scheduled_for
 WHERE status = 'dispatching'
   AND claimed_at IS NULL;

UPDATE public.pending_sends
   SET claimed_at = send_at
 WHERE status = 'sending'
   AND claimed_at IS NULL;
