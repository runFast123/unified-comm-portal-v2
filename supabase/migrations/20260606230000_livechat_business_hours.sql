-- Business hours / offline mode. When enabled, the server computes online/offline
-- from the schedule + timezone; outside hours the widget shows offline_message and
-- the visitor can still leave a message (lands in the inbox, followable-up by email).
-- business_hours shape: { tz: string, days: string[] (mon..sun), open: 'HH:MM', close: 'HH:MM' }
ALTER TABLE public.livechat_widgets
  ADD COLUMN IF NOT EXISTS business_hours_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS business_hours jsonb,
  ADD COLUMN IF NOT EXISTS offline_message text NOT NULL DEFAULT '';
