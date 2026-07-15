-- ============================================================================
-- Correct the stale `ai_providers.api_key` column comment.
--
-- 20260601170000_ai_providers.sql set this comment when the column really did
-- hold plaintext:
--
--   'Plaintext API key (matches the legacy ai_config table). getAIConfig reads
--    it directly. The HTTP layer masks it and never returns the raw value.'
--
-- That has since become FALSE, and misleadingly so — it tells a reader the
-- column is plaintext-by-design and that nothing decrypts it, which would
-- justify treating a stored value as directly usable. Encryption-at-rest
-- landed afterwards: `resolveStoredApiKey` (src/lib/api-helpers.ts) decrypts
-- envelope ciphertext, and every write path now encrypts. The comment is live
-- in the DB (readable via \d+, information_schema, and the Supabase dashboard),
-- so correcting the repo alone would not fix it.
--
-- Per supabase/migrations/README.md ("Do NOT edit applied files — write a
-- follow-up instead") this is a fix-forward: the original migration keeps its
-- historical text and this one overwrites the comment. Same pattern as
-- 20260613120000, which re-COMMENTed pending_sends.status.
--
-- Comment-only. No data, no schema, no privileges change. Idempotent.
-- ============================================================================

COMMENT ON COLUMN public.ai_providers.api_key IS
  'API key, encrypted at rest. New writes use the AES-256-GCM envelope format from src/lib/encryption.ts ("v1:<keyId>:base64(iv||authTag||ciphertext)"). Legacy plaintext rows are tolerated on read and lazily re-encrypted in place (compare-and-swap, fire-and-forget) — see resolveStoredApiKey in src/lib/api-helpers.ts. A ciphertext whose key has been rotated out of the ring decrypts to null and the caller falls through to the next config tier. The HTTP layer (/api/ai-providers) never returns the raw value; it masks to has_api_key + api_key_masked.';
