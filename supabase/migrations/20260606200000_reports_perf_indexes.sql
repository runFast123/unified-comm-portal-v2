-- Reports-page performance: its queries filter ai_replies by (account_id, created_at)
-- and message_classifications by classified_at over a date range, but those date
-- columns had no index — forcing sequential scans that grow with table size.
CREATE INDEX IF NOT EXISTS idx_ai_replies_account_created
  ON public.ai_replies (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_classifications_classified_at
  ON public.message_classifications (classified_at);
