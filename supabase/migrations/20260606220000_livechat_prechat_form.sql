-- Pre-chat capture: when enabled, the widget asks the visitor for name + email
-- before the conversation starts (lead capture + agent context). Non-secret
-- appearance/behavior flag, public via /api/widget/config.
ALTER TABLE public.livechat_widgets
  ADD COLUMN IF NOT EXISTS prechat_enabled boolean NOT NULL DEFAULT false;
