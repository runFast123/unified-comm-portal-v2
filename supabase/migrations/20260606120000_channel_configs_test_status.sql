-- BYOC: persist the result of a Test-Connection per account+channel so the
-- admin UI can show a "Verified / Failed / Not tested" gate before a tenant's
-- own credentials go live. Nullable; populated by recordChannelConfigTest() and
-- reset to NULL whenever the credentials are (re)saved.
ALTER TABLE public.channel_configs
  ADD COLUMN IF NOT EXISTS last_tested_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_test_ok boolean,
  ADD COLUMN IF NOT EXISTS last_test_error text;
