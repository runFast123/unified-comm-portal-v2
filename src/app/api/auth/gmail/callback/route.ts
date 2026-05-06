import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { getChannelConfig, saveChannelConfig, type EmailConfig } from '@/lib/channel-config'
import { exchangeGmailAuthCode } from '@/lib/gmail-oauth'
import { verifyState } from '@/lib/oauth-state'

export const dynamic = 'force-dynamic'

const STATE_COOKIE = 'gmail-oauth-state'
const CHANNELS_PAGE = '/admin/channels'

function redirectBack(origin: string, params: Record<string, string>): NextResponse {
  const url = new URL(CHANNELS_PAGE, origin)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url.toString(), { status: 302 })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = url.origin
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')

  const jar = await cookies()
  const rawCookie = jar.get(STATE_COOKIE)?.value
  // Always clear the state cookie — it's single-use.
  jar.delete(STATE_COOKIE)

  // Google returned an error instead of a code (user denied consent,
  // app not verified blocked, etc.). Surface it to the UI.
  if (oauthError) {
    return redirectBack(origin, { gmail_oauth_error: oauthError })
  }

  if (!code || !state) {
    return redirectBack(origin, { gmail_oauth_error: 'missing_code' })
  }

  // Verify the HMAC on the state cookie BEFORE trusting any payload
  // fields. A malformed cookie, missing secret, or bad MAC returns null.
  const cookieState = verifyState(rawCookie)
  if (!cookieState) {
    return redirectBack(origin, { gmail_oauth_error: 'invalid_state' })
  }
  if (cookieState.nonce !== state) {
    return redirectBack(origin, { gmail_oauth_error: 'state_mismatch' })
  }
  if (Date.now() >= cookieState.expires_at) {
    return redirectBack(origin, { gmail_oauth_error: 'state_expired' })
  }

  const accountId = cookieState.account_id
  const redirectUri = `${origin}/api/auth/gmail/callback`

  let tokenResult
  try {
    tokenResult = await exchangeGmailAuthCode(code, redirectUri)
  } catch (err) {
    console.error('Gmail OAuth code exchange failed:', err)
    return redirectBack(origin, { gmail_oauth_error: 'exchange_failed' })
  }

  // Fetch the connected user's identity (email + sub) from the userinfo
  // endpoint. Required so we can display "Connected as X" and use the
  // right user on the XOAUTH2 envelope.
  let userEmail: string | undefined
  let userId: string | undefined
  try {
    const meRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenResult.access_token}` },
    })
    if (meRes.ok) {
      const me = (await meRes.json()) as {
        email?: string
        sub?: string
      }
      userEmail = me.email
      userId = me.sub
    }
  } catch {
    /* non-fatal — display fields are best-effort */
  }

  if (!userEmail) {
    // We really need the email — XOAUTH2 and the "from" address both
    // depend on it. Bail rather than store a broken config.
    return redirectBack(origin, { gmail_oauth_error: 'userinfo_failed' })
  }

  // Merge with any existing config — we preserve fields the user already
  // set (e.g. smtp_from_name customisation) and only fill in Gmail defaults
  // for fields that are empty/missing.
  const existing = (await getChannelConfig(accountId, 'email')) as EmailConfig | null

  const defaults = {
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_secure: true,
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_secure: true,
  }

  const merged: EmailConfig = {
    // Start from existing config OR an empty shell if this is a first-time setup.
    smtp_host: existing?.smtp_host || defaults.smtp_host,
    smtp_port:
      existing?.smtp_port && existing.smtp_port > 0 ? existing.smtp_port : defaults.smtp_port,
    smtp_secure:
      existing?.smtp_secure !== undefined ? existing.smtp_secure : defaults.smtp_secure,
    smtp_user: existing?.smtp_user || userEmail,
    // Password is irrelevant in OAuth mode — preserve whatever was there
    // (in case they later flip back to SMTP) but default to empty string.
    smtp_password: existing?.smtp_password || '',
    smtp_from_name: existing?.smtp_from_name || 'Unified Comm Portal',
    imap_host: existing?.imap_host || defaults.imap_host,
    imap_port:
      existing?.imap_port && existing.imap_port > 0 ? existing.imap_port : defaults.imap_port,
    imap_secure:
      existing?.imap_secure !== undefined ? existing.imap_secure : defaults.imap_secure,
    imap_user: existing?.imap_user || userEmail,
    imap_password: existing?.imap_password || '',
    // OAuth fields — these are the source of truth going forward.
    auth_mode: 'gmail_oauth',
    google_refresh_token: tokenResult.refresh_token,
    google_access_token: tokenResult.access_token,
    google_access_token_expires_at: Date.now() + (tokenResult.expires_in - 60) * 1000,
    google_user_email: userEmail,
    google_user_id: userId,
    google_connected_at: Date.now(),
  }

  try {
    await saveChannelConfig(accountId, 'email', merged)
  } catch (err) {
    console.error('Failed to save Gmail OAuth config:', err)
    return redirectBack(origin, { gmail_oauth_error: 'save_failed' })
  }

  // OAuth-first create flow leaves accounts.gmail_address null — fill it in
  // from the signed-in Google identity now that we have it. We never
  // overwrite an admin-entered address, only populate when missing.
  //
  // Also reset the polling-failure counter and clear last_poll_error: a
  // successful re-auth almost always means the previous failure cause
  // (expired refresh token, revoked grant, "Unexpected close" auth churn)
  // is gone. Without this reset the circuit breaker stays open even
  // though credentials are now valid, and the cron keeps skipping the
  // account on every tick — fresh OAuth then looks like it "didn't fix
  // anything" until ops notices and resets the counter manually.
  try {
    const admin = await createServiceRoleClient()
    const { data: existingAcc } = await admin
      .from('accounts')
      .select('gmail_address')
      .eq('id', accountId)
      .maybeSingle()
    const patch: {
      gmail_address?: string
      consecutive_poll_failures: number
      last_poll_error: null
      last_poll_error_at: null
    } = {
      consecutive_poll_failures: 0,
      last_poll_error: null,
      last_poll_error_at: null,
    }
    if (existingAcc && !existingAcc.gmail_address) {
      patch.gmail_address = userEmail
    }
    await admin
      .from('accounts')
      .update(patch)
      .eq('id', accountId)
  } catch (err) {
    // Non-fatal — the OAuth config itself is saved, UI will still work.
    console.error('Failed to backfill accounts.gmail_address / reset breaker:', err)
  }

  // Audit log (best-effort).
  try {
    const admin = await createServiceRoleClient()
    await admin.from('audit_log').insert({
      user_id: null,
      action: 'gmail.oauth.connected',
      entity_type: 'channel_config',
      entity_id: null,
      details: { account_id: accountId, channel: 'email', user_email: userEmail },
    })
  } catch {
    /* ignore audit failure */
  }

  return redirectBack(origin, {
    gmail_oauth: 'success',
    as: userEmail,
  })
}
