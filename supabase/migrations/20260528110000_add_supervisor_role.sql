-- ============================================================================
-- Add 'supervisor' tier to the user_role enum (preparation only).
--
-- Sits between company_admin and company_member in the trust hierarchy.
-- This migration ONLY extends the enum — Phase 2 will add the helper
-- function and gate destructive ops (assign, merge, CSAT send, AI approve)
-- behind it. See 20260528110100_add_supervisor_helper.sql for the
-- companion is_supervisor() function (split into a separate migration
-- because PostgreSQL forbids using a newly-added enum value in the same
-- transaction that added it).
--
-- New target hierarchy:
--   super_admin → company_admin → supervisor (new) → company_member
-- ============================================================================

ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'supervisor' BEFORE 'company_member';
