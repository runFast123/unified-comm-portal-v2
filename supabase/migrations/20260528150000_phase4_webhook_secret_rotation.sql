-- Phase 4: webhook secret rotation grace-period support.
--
-- A "rotate secret" admin action stashes the prior signing_secret here for a
-- grace period (24h) so the customer's endpoint can be updated without an
-- in-flight outage. Verification on the OUR side does not happen — the
-- dispatcher signs outgoing payloads with `signing_secret` only. The
-- `previous_secret` is purely informational + a safety net if we ever need
-- to expose it to the customer ("here's your old key, valid until X").

ALTER TABLE public.webhook_subscriptions
  ADD COLUMN IF NOT EXISTS previous_secret text,
  ADD COLUMN IF NOT EXISTS secret_rotated_at timestamptz;
