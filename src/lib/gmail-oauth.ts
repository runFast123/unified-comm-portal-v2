import { getChannelConfig, saveChannelConfig, type EmailConfig } from '@/lib/channel-config'
import { getGoogleOAuth } from '@/lib/integration-settings'
import { createServiceRoleClient } from '@/lib/supabase-server'

/**
 * Gmail OAuth 2.0 helpers.
 *
 * The "Sign in with Google" flow keeps the protocol familiar (SMTP send,
 * IMAP receive) but swaps password auth for XOAUTH2. We never see the
 * user's Google password; we just hold a refresh token and mint short-
 * lived access tokens on demand.
 *
 * Contract:
 *  - Caller passes the decrypted EmailConfig and the owning account_id.
 *  - We return a valid access_token (cached or freshly minted).
 *  - If the refresh token is missing / revoked / consent withdrawn we
 *    throw GmailOAuthExpiredError so the UI can prompt re-auth.
 *
 * Note on multi-tenancy: OAuth client credentials are PER-COMPANY (see
 * src/lib/integration-settings.ts + migration 20260528170000). Every
 * resolver here looks the company_id up from the owning account before
 * calling getGoogleOAuth().
 */

// https://mail.google.com/ is required for IMAP/SMTP OAuth2 (there is no
// read-only IMAP scope — Google gates mail transport behind the full
// scope). openid+email+profile give us the user's email for display.
const SCOPES = 'https://mail.google.com/ openid email profile'
const ACCESS_TOKEN_SAFETY_MARGIN_MS = 30_000

export class GmailOAuthExpiredError extends Error {
  constructor(message = 'Gmail OAuth expired — reconnect required') {
    super(message)
    this.name = 'GmailOAuthExpiredError'
  }
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type?: string
  scope?: string
  id_token?: string
}

interface TokenErrorResponse {
  error?: string
  error_description?: string
}

/**
 * Look up the company that owns this account so we can fetch the right
 * per-company OAuth client. Throws if the account doesn't exist or has
 * no company assigned — we'd rather fail loudly than silently fall back
 * to env vars for the wrong tenant.
 */
async function companyIdForAccount(accountId: string): Promise<string> {
  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('accounts')
    .select('company_id')
    .eq('id', accountId)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to resolve company for account ${accountId}: ${error.message}`)
  }
  if (!data?.company_id) {
    throw new Error(
      `Account ${accountId} has no company_id — cannot resolve Gmail OAuth client. ` +
        `Assign the account to a company first.`
    )
  }
  return data.company_id as string
}

async function requireClientCreds(
  companyId: string
): Promise<{ clientId: string; clientSecret: string }> {
  // DB-backed (integration_settings) with env fallback — admins can configure
  // OAuth via /admin/integrations without a redeploy.
  const creds = await getGoogleOAuth(companyId)
  if (!creds) {
    throw new Error(
      'Gmail OAuth is not configured. Go to /admin/integrations to set the Google OAuth client ID and secret.'
    )
  }
  return { clientId: creds.client_id, clientSecret: creds.client_secret }
}

/**
 * Acquire a Gmail access token for an account.
 *  1. Return the cached access token if still valid (30s safety margin).
 *  2. Otherwise exchange the stored refresh token at Google's token endpoint.
 *     Google rotates refresh tokens rarely but possibly — if the response
 *     includes a new refresh_token we persist it (merged into existing cfg).
 *  3. On invalid_grant (consent revoked, password changed, token aged out,
 *     project deleted, etc.) we throw GmailOAuthExpiredError.
 *
 * Accepts `accountId` so we can persist rotated refresh tokens back to the
 * DB AND resolve the per-company OAuth client. If accountId is null we
 * can't determine which tenant's OAuth client to use, so we throw — the
 * old behaviour of returning a usable token but skipping write-back is no
 * longer safe because the wrong client_id/secret could be picked.
 */
export async function getGmailAccessToken(
  cfg: EmailConfig,
  accountId: string | null
): Promise<string> {
  if (!cfg.google_refresh_token) {
    throw new GmailOAuthExpiredError('No Gmail refresh token on file — reconnect required')
  }

  const now = Date.now()
  if (
    cfg.google_access_token &&
    cfg.google_access_token_expires_at &&
    cfg.google_access_token_expires_at > now + ACCESS_TOKEN_SAFETY_MARGIN_MS
  ) {
    return cfg.google_access_token
  }

  // Snapshot the refresh token we're about to trade in. Used below for
  // optimistic locking so concurrent pollers don't overwrite each other's
  // rotated tokens.
  const startingRefreshToken = cfg.google_refresh_token

  // Resolve OAuth client per company. accountId is required from this
  // point — see the function-level doc comment for why.
  if (!accountId) {
    throw new Error(
      'getGmailAccessToken requires accountId to resolve the per-company OAuth client.'
    )
  }
  const companyId = await companyIdForAccount(accountId)
  const { clientId, clientSecret } = await requireClientCreds(companyId)

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: cfg.google_refresh_token,
    }),
  })

  if (!res.ok) {
    let err: TokenErrorResponse = {}
    try {
      err = (await res.json()) as TokenErrorResponse
    } catch {
      /* body may be empty or non-JSON */
    }
    if (err.error === 'invalid_grant' || err.error === 'unauthorized_client') {
      throw new GmailOAuthExpiredError(
        `Gmail OAuth expired — reconnect required (${err.error_description || err.error})`
      )
    }
    throw new Error(
      `Gmail token refresh failed: ${res.status} ${err.error || ''} ${err.error_description || ''}`.trim()
    )
  }

  const json = (await res.json()) as TokenResponse
  const expiresAtMs = Date.now() + (json.expires_in - 60) * 1000

  // Persist the rotated refresh token (if any) and cache the access token.
  // Best-effort: a write-back failure should not prevent us from returning
  // a usable token for this request.
  //
  // Optimistic locking — the channel_configs row stores the entire config as
  // one encrypted blob, so we can't do a narrow column UPDATE ... WHERE
  // refresh_token = ?. Instead, re-fetch right before write and compare the
  // refresh_token we started with. If someone else already rotated, use
  // their tokens and skip our write — otherwise we'd clobber a fresher
  // refresh token with our now-stale one.
  try {
    const freshCfg = (await getChannelConfig(accountId, 'email')) as EmailConfig | null
    if (
      freshCfg &&
      freshCfg.google_refresh_token &&
      freshCfg.google_refresh_token !== startingRefreshToken
    ) {
      // Concurrent rotation detected — prefer their newer access token if
      // it's still valid, else fall back to the one we just minted.
      if (
        freshCfg.google_access_token &&
        freshCfg.google_access_token_expires_at &&
        freshCfg.google_access_token_expires_at > Date.now() + ACCESS_TOKEN_SAFETY_MARGIN_MS
      ) {
        return freshCfg.google_access_token
      }
      return json.access_token
    }
    const updated: EmailConfig = {
      ...(freshCfg ?? cfg),
      auth_mode: 'gmail_oauth',
      google_refresh_token: json.refresh_token || startingRefreshToken,
      google_access_token: json.access_token,
      google_access_token_expires_at: expiresAtMs,
    }
    await saveChannelConfig(accountId, 'email', updated)
  } catch (writeErr) {
    console.error('Failed to persist rotated Gmail tokens:', writeErr)
  }

  return json.access_token
}

/**
 * Exchange an authorization code for access + refresh tokens. Used by the
 * OAuth callback handler. Requires access_type=offline AND prompt=consent
 * on the authorize request to reliably get a refresh token.
 *
 * Takes the owning account_id so we can resolve the per-company OAuth client
 * — the callback handler sources this from the verified state cookie.
 */
export async function exchangeGmailAuthCode(
  code: string,
  redirectUri: string,
  accountId: string
): Promise<{
  access_token: string
  refresh_token: string
  expires_in: number
  id_token?: string
}> {
  const companyId = await companyIdForAccount(accountId)
  const { clientId, clientSecret } = await requireClientCreds(companyId)

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  })

  if (!res.ok) {
    let body = ''
    try {
      body = await res.text()
    } catch {
      /* ignore */
    }
    throw new Error(`Gmail auth code exchange failed: ${res.status} ${body.slice(0, 400)}`)
  }

  const json = (await res.json()) as TokenResponse
  if (!json.access_token || !json.refresh_token) {
    // No refresh_token means Google decided to reuse an existing grant
    // (happens when the user already consented and access_type=offline or
    // prompt=consent were omitted). Without it, we can't do long-lived IMAP.
    throw new Error(
      'Google token response missing refresh_token — ensure access_type=offline and prompt=consent are set on the authorize request'
    )
  }

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
    id_token: json.id_token,
  }
}

export const GMAIL_OAUTH_SCOPES = SCOPES
