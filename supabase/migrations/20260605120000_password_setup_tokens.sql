-- Custom, prefetch-safe "set your password" tokens. Unlike GoTrue
-- recovery/invite links (single-use, consumed on the first GET — so a link
-- preview / email scanner / browser prefetch burns them before the human
-- clicks — short-lived, and dependent on the redirect allow-list), these are:
--   * consumed on the password-SUBMIT (POST), never on a GET → prefetch-safe
--   * given a TTL we control (72h)
--   * stored only as a SHA-256 hash, so a DB leak exposes no usable token
-- Validated + spent server-side by POST /api/auth/set-password.
create table if not exists public.password_setup_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_password_setup_tokens_user on public.password_setup_tokens (user_id);

-- Only the service-role client (which BYPASSES RLS) may touch this table; the
-- token hashes must never be readable by a signed-in user. RLS on + zero
-- policies = deny-by-default for anon/authenticated.
alter table public.password_setup_tokens enable row level security;
revoke all on public.password_setup_tokens from anon, authenticated;
