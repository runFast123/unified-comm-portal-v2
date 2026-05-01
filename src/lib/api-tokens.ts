// ─── Per-company API tokens ─────────────────────────────────────────
//
// Opaque bearer tokens minted per company so customers can integrate the
// portal with external systems (Zapier, n8n, custom code, CRMs).
//
// The token format is:
//
//   ucp_<24 random base64url chars>
//
// We never store the plaintext. At creation we hash with SHA-256 and store
// the hex digest in `api_tokens.token_hash` (UNIQUE). The plaintext is
// returned to the user exactly once, in the `POST /api/admin/api-tokens`
// response. Verification happens by hashing the inbound token and looking
// up the matching row — constant-time enough for a hash compare and avoids
// the need for any per-request decryption.
//
// `prefix` is the first 8 chars (e.g. "ucp_abcd"); we render that in the
// list UI so customers can identify their tokens without ever seeing the
// secret again.
//
// Scopes are free-form strings (`conversations:read`, `messages:write`,
// etc). Routes call `requireScope()` which throws `ScopeRequiredError`.

import crypto from 'crypto'

import { createServiceRoleClient } from '@/lib/supabase-server'

// ── Constants ───────────────────────────────────────────────────────

/** Plaintext token prefix. All tokens start with this. */
export const TOKEN_PREFIX = 'ucp_'

/** Number of random base64url chars after the prefix. */
const RANDOM_LEN = 24

/** Number of leading chars (incl. `ucp_`) we expose for UI identification. */
const PREFIX_VISIBLE_LEN = 8

/** Known scope strings — informational; the DB stores arbitrary text. */
export const KNOWN_SCOPES = [
  'conversations:read',
  'conversations:write',
  'messages:read',
  'messages:write',
] as const
export type KnownScope = (typeof KNOWN_SCOPES)[number]

// ── Errors ──────────────────────────────────────────────────────────

/** Thrown by `requireScope` when the token does not grant the required scope. */
export class ScopeRequiredError extends Error {
  readonly scope: string
  constructor(scope: string) {
    super(`Token missing required scope: ${scope}`)
    this.name = 'ScopeRequiredError'
    this.scope = scope
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Hash a plaintext token with SHA-256 → hex. Pure, no IO. Exposed so tests
 * and the verify path can call it directly.
 */
export function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex')
}

/**
 * Generate a fresh API token: returns the plaintext (to display to the
 * user once), the SHA-256 hex hash (to store in `token_hash`), and the
 * UI display prefix. Pure / no IO.
 */
export function generateToken(): {
  plaintext: string
  hash: string
  prefix: string
} {
  // 18 bytes → 24 base64url chars (no padding). Cryptographically random;
  // ~144 bits of entropy is well above what's needed for a bearer secret.
  const random = crypto.randomBytes(18).toString('base64url')
  const plaintext = `${TOKEN_PREFIX}${random}`
  return {
    plaintext,
    hash: hashToken(plaintext),
    prefix: plaintext.slice(0, PREFIX_VISIBLE_LEN),
  }
}

// ── Verification result ─────────────────────────────────────────────

export interface TokenInfo {
  /** api_tokens.id */
  token_id: string
  /** api_tokens.company_id */
  company_id: string
  /** api_tokens.scopes */
  scopes: string[]
}

/**
 * Look up a plaintext token, return its TokenInfo if active, or null
 * otherwise (revoked / expired / not found / malformed).
 *
 * Side effect: bumps `last_used_at` to now() on a successful lookup. The
 * update is best-effort — if it fails we still return the TokenInfo so a
 * transient DB hiccup on the audit column doesn't lock the customer out.
 */
export async function verifyToken(plaintext: string): Promise<TokenInfo | null> {
  if (typeof plaintext !== 'string') return null
  const trimmed = plaintext.trim()
  // Fast reject for obvious garbage so we don't burn a DB roundtrip on
  // every empty / unprefixed Authorization header.
  if (!trimmed.startsWith(TOKEN_PREFIX)) return null
  if (trimmed.length < TOKEN_PREFIX.length + 8) return null

  const hash = hashToken(trimmed)
  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('api_tokens')
    .select('id, company_id, scopes, revoked_at, expires_at')
    .eq('token_hash', hash)
    .maybeSingle()

  if (error || !data) return null

  // Reject revoked tokens.
  if (data.revoked_at) return null

  // Reject expired tokens. `expires_at` is optional.
  if (data.expires_at) {
    const expiresAt = new Date(data.expires_at).getTime()
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return null
    }
  }

  // Best-effort last_used_at bump.
  try {
    await admin
      .from('api_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id)
  } catch {
    /* non-fatal */
  }

  return {
    token_id: data.id,
    company_id: data.company_id,
    scopes: Array.isArray(data.scopes) ? (data.scopes as string[]) : [],
  }
}

/**
 * Throws `ScopeRequiredError` when the token's scopes do not include
 * `scope`. No-op when granted. Pure synchronous check.
 */
export function requireScope(scope: string, tokenInfo: TokenInfo): void {
  if (!tokenInfo.scopes.includes(scope)) {
    throw new ScopeRequiredError(scope)
  }
}

// ── Bearer header parsing ───────────────────────────────────────────

/**
 * Extract the bearer token plaintext from an `Authorization` header value.
 * Returns the trimmed token, or null when the header is missing / not a
 * valid `Bearer <token>` form.
 */
export function parseBearerHeader(value: string | null | undefined): string | null {
  if (!value) return null
  const m = value.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const tok = m[1].trim()
  return tok.length > 0 ? tok : null
}
