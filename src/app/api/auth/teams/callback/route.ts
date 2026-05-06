import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { getChannelConfig, saveChannelConfig, type TeamsConfig } from '@/lib/channel-config'
import { exchangeAuthCode } from '@/lib/teams-delegated'
import { verifyState } from '@/lib/oauth-state'

export const dynamic = 'force-dynamic'

const STATE_COOKIE = 'teams-oauth-state'
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

  // Microsoft returned an error rather than a code (user cancelled, admin
  // consent required, etc.). Surface it to the UI.
  if (oauthError) {
    return redirectBack(origin, { teams_oauth_error: oauthError })
  }

  if (!code || !state) {
    return redirectBack(origin, { teams_oauth_error: 'missing_code' })
  }

  // HMAC-verify the state cookie BEFORE trusting its contents.
  const cookieState = verifyState(rawCookie)
  if (!cookieState) {
    return redirectBack(origin, { teams_oauth_error: 'invalid_state' })
  }
  if (cookieState.nonce !== state) {
    return redirectBack(origin, { teams_oauth_error: 'state_mismatch' })
  }
  if (Date.now() >= cookieState.expires_at) {
    return redirectBack(origin, { teams_oauth_error: 'state_expired' })
  }

  const accountId = cookieState.account_id
  const existingCfg = await getChannelConfig(accountId, 'teams')
  if (!existingCfg || !existingCfg.azure_tenant_id || !existingCfg.azure_client_id || !existingCfg.azure_client_secret) {
    return redirectBack(origin, { teams_oauth_error: 'config_missing' })
  }

  const redirectUri = `${origin}/api/auth/teams/callback`

  let tokenResult
  try {
    tokenResult = await exchangeAuthCode({ cfg: existingCfg, code, redirectUri })
  } catch (err) {
    console.error('Teams OAuth code exchange failed:', err)
    return redirectBack(origin, { teams_oauth_error: 'exchange_failed' })
  }

  // Fetch the connected user's identity (display only).
  let userEmail: string | undefined
  let userId: string | undefined
  try {
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokenResult.access_token}` },
    })
    if (meRes.ok) {
      const me = (await meRes.json()) as {
        userPrincipalName?: string
        mail?: string
        id?: string
      }
      userEmail = me.userPrincipalName || me.mail
      userId = me.id
    }
  } catch {
    /* non-fatal — display fields are best-effort */
  }

  const merged: TeamsConfig = {
    ...existingCfg,
    auth_mode: 'delegated',
    delegated_refresh_token: tokenResult.refresh_token,
    delegated_access_token: tokenResult.access_token,
    delegated_access_token_expires_at: Date.now() + (tokenResult.expires_in - 60) * 1000,
    delegated_user_email: userEmail,
    delegated_user_id: userId,
    delegated_connected_at: Date.now(),
  }

  try {
    await saveChannelConfig(accountId, 'teams', merged)
  } catch (err) {
    console.error('Failed to save delegated Teams config:', err)
    return redirectBack(origin, { teams_oauth_error: 'save_failed' })
  }

  // OAuth-first create flow leaves accounts.teams_user_id null — fill it
  // in from Graph /me now that we know the signed-in UPN. Never overwrite
  // an admin-entered value (e.g. they may have specified a GUID on purpose).
  //
  // Also reset the polling-failure counter so a successful re-auth lets
  // the circuit breaker close on the next cron tick. Without this the
  // breaker stays open even with valid credentials, and the cron keeps
  // skipping the account. Symmetric with the Gmail OAuth callback.
  try {
    const admin = await createServiceRoleClient()
    const { data: existingAcc } = await admin
      .from('accounts')
      .select('teams_user_id')
      .eq('id', accountId)
      .maybeSingle()
    const patch: {
      teams_user_id?: string
      consecutive_poll_failures: number
      last_poll_error: null
      last_poll_error_at: null
    } = {
      consecutive_poll_failures: 0,
      last_poll_error: null,
      last_poll_error_at: null,
    }
    if (userEmail && existingAcc && !existingAcc.teams_user_id) {
      patch.teams_user_id = userEmail
    }
    await admin
      .from('accounts')
      .update(patch)
      .eq('id', accountId)
  } catch (err) {
    // Non-fatal — the OAuth config itself is saved, UI will still work.
    console.error('Failed to backfill accounts.teams_user_id / reset breaker:', err)
  }

  // Audit log. We don't have a user-id readily available in this callback
  // (the user is authenticated to Microsoft here, not necessarily to
  // Supabase in the same request — browsers send the Supabase session
  // cookie too, but we prefer a minimal dependency and use service role).
  try {
    const admin = await createServiceRoleClient()
    await admin.from('audit_log').insert({
      user_id: null,
      action: 'teams.oauth.connected',
      entity_type: 'channel_config',
      entity_id: null,
      details: { account_id: accountId, channel: 'teams', user_email: userEmail },
    })
  } catch {
    /* ignore audit failure */
  }

  return redirectBack(origin, {
    teams_oauth: 'success',
    ...(userEmail ? { as: userEmail } : {}),
  })
}
