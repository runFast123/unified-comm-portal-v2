-- ============================================================================
-- Email signatures with two-level inheritance:
--   * companies.default_email_signature — company-wide default
--   * users.email_signature             — per-user override (when set + enabled)
--   * users.email_signature_enabled     — per-user opt-out flag (default true)
--
-- The send route resolves: user (if set + enabled) -> company default -> none.
-- Variables substituted inside the signature at send time:
--   {{user.full_name}}, {{user.email}}, {{company.name}}, {{date}}
--
-- All DDL is idempotent so this can be re-run safely. Coordinated with the
-- parallel multi-tenancy migration which only touches additional `companies`
-- columns — this one is scoped strictly to signature fields.
-- ============================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email_signature text,
  ADD COLUMN IF NOT EXISTS email_signature_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS default_email_signature text;
