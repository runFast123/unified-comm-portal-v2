import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { randomBytes } from 'crypto'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { GMAIL_OAUTH_SCOPES } from '@/lib/gmail-oauth'
import { getGoogleOAuth } from '@/lib/integration-settings'
import { signState } from '@/lib/oauth-state'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import { verifyAccountAccess } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

const STATE_COOKIE = 'gmail-oauth-state'
const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes

async function requireAdmin() {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  // Allow super_admin (cross-tenant) and company-level admins (company-scoped).
  // Account-level scoping is enforced via verifyAccountAccess() below.
  if (!profile || (!isSuperAdmin(profile.role) && !isCompanyAdmin(profile.role))) {
    return { ok: false as const, status: 403, error: 'Admin only' }
  }
  return { ok: true as const, userId: user.id }
}

export async function GET(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  const url = new URL(request.url)
  const accountId = url.searchParams.get('account_id')
  if (!accountId) {
    return NextResponse.json({ error: 'account_id required' }, { status: 400 })
  }

  // Account scope: company admins can only OAuth accounts in their own company.
  // super_admin bypasses this check inside verifyAccountAccess().
  const allowed = await verifyAccountAccess(gate.userId, accountId)
  if (!allowed) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  // Fail fast if OAuth creds aren't configured (DB or env) — otherwise the
  // user would bounce to Google, get a client_id error, and have no idea
  // what to fix. DB takes precedence over env vars.
  const creds = await getGoogleOAuth()
  if (!creds) {
    return NextResponse.json(
      {
        error:
          'Gmail OAuth not configured. An admin must configure the Google OAuth client at /admin/integrations (or set the GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET env vars).',
      },
      { status: 500 }
    )
  }
  const clientId = creds.client_id

  // Verify the account exists and is email-channel. We don't need an
  // existing EmailConfig here (this IS how they configure credentials),
  // so don't reject accounts with no saved config yet.
  const admin = await createServiceRoleClient()
  const { data: account } = await admin
    .from('accounts')
    .select('id, channel_type')
    .eq('id', accountId)
    .maybeSingle()
  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }
  if (account.channel_type !== 'email') {
    return NextResponse.json(
      { error: 'Gmail OAuth is only valid for email-channel accounts' },
      { status: 400 }
    )
  }

  // CSRF state cookie: HMAC-signed JSON { account_id, nonce, expires_at }.
  // The `state` query parameter carries only the nonce; the cookie is
  // authoritative for which account we're binding the tokens to. Signing
  // prevents an attacker who can plant a cookie from choosing which
  // account the issued tokens get written to.
  const nonce = randomBytes(24).toString('hex')
  const cookieValue = signState({
    account_id: accountId,
    nonce,
    expires_at: Date.now() + STATE_TTL_MS,
  })

  const jar = await cookies()
  jar.set(STATE_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: STATE_TTL_MS / 1000,
  })

  // Redirect URI MUST match a URI registered in the Google Cloud OAuth client.
  const origin = url.origin
  const redirectUri = `${origin}/api/auth/gmail/callback`

  const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('scope', GMAIL_OAUTH_SCOPES)
  // access_type=offline is required to get a refresh token.
  authorizeUrl.searchParams.set('access_type', 'offline')
  // prompt=consent forces the consent screen each time, which guarantees
  // Google issues a fresh refresh_token (re-consenting user) rather than
  // silently reusing an existing grant with no refresh token returned.
  authorizeUrl.searchParams.set('prompt', 'consent')
  authorizeUrl.searchParams.set('state', nonce)
  // include_granted_scopes keeps any other scopes the user already granted
  // (not strictly needed here but harmless).
  authorizeUrl.searchParams.set('include_granted_scopes', 'true')

  return NextResponse.redirect(authorizeUrl.toString(), { status: 302 })
}
