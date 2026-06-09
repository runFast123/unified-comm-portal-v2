-- Proactive trigger: auto-open the widget after N seconds (0 = off). Public via
-- /api/widget/config; the widget fires it once per browser tab session.
ALTER TABLE public.livechat_widgets
  ADD COLUMN IF NOT EXISTS proactive_delay integer NOT NULL DEFAULT 0;
