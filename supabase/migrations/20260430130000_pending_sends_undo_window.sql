-- ============================================================================
-- Undo Send: server-side delayed dispatch buffer.
--
-- When the UI passes `delay_ms > 0` to /api/send, the request inserts a row
-- here instead of firing the SMTP/Graph send immediately. The user has
-- send_at - now() seconds (default 5s) to hit the Undo button, which calls
-- /api/send/cancel and flips status to 'cancelled'. The dispatch-scheduled
-- cron picks up rows where status='pending' AND send_at <= now() and runs
-- the actual send via the same channel-sender helpers /api/send uses.
--
-- Idempotent (`IF NOT EXISTS`) so re-applying the migration is safe.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pending_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  channel         text NOT NULL,
  reply_text      text NOT NULL,
  to_address      text,
  subject         text,
  teams_chat_id   text,
  attachments     jsonb,
  created_by      uuid NOT NULL REFERENCES auth.users(id),
  send_at         timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  error           text
);

-- Partial index — the cron only reads pending+due rows, so the index stays
-- tiny even after we accumulate audit history of sent/cancelled rows.
CREATE INDEX IF NOT EXISTS idx_pending_sends_due
  ON public.pending_sends (send_at)
  WHERE status = 'pending';

-- Lookup by owner — used by /api/send/cancel to ownership-check before
-- flipping status. Helps when the table grows.
CREATE INDEX IF NOT EXISTS idx_pending_sends_created_by
  ON public.pending_sends (created_by);

ALTER TABLE public.pending_sends ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pending_sends IS
  'Undo-Send buffer. Rows are written by /api/send when delay_ms > 0 and dispatched by the dispatch-scheduled cron once send_at passes. Cancellable while status=pending.';
COMMENT ON COLUMN public.pending_sends.status IS
  'pending | sending | sent | cancelled | failed';
