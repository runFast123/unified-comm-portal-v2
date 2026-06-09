-- More widget customization: a subtitle line, an optional launcher label, and
-- the corner the widget docks in. All non-secret appearance fields (public via
-- /api/widget/config). position is validated in the admin PATCH ('left'|'right').
ALTER TABLE public.livechat_widgets
  ADD COLUMN IF NOT EXISTS subtitle text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS launcher_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS position text NOT NULL DEFAULT 'right';
