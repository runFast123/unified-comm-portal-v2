-- Multiple widgets per company: each widget is its own livechat account; `name`
-- is the friendly label (mirrored to the account name so the inbox shows it).
ALTER TABLE public.livechat_widgets
  ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'Live Chat';
