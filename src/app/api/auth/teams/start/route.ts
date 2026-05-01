import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { randomBytes } from 'crypto'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getChannelConfig } from '@/lib/channel-config'
import { TEAMS_OAUTH_SCOPES } from '@/lib/teams-delegated'
import { signState } from '@/lib/oauth-state'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import { verifyAccountAccess } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

const STATE_COOKIE = 'teams-oauth-state'
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

  const cfg = await getChannelConfig(accountId, 'teams')
  if (!cfg || !cfg.azure_tenant_id || !cfg.azure_client_id) {
    return NextResponse.json(
      { error: 'Configure Teams credentials (tenant + client_id) for this account first' },
      { status: 400 }
    )
  }

  // Build CSRF state cookie: HMAC-signed JSON { account_id, nonce, expires_at }.
  // The `state` query parameter carries only the nonce; the cookie is
  // authoritative for which account we're binding the tokens to. Signing
  // blocks an attacker from swapping the account_id on a planted cookie.
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

  // Redirect URI MUST match the one registered in Azure App Registration.
  const origin = url.origin
  const redirectUri = `${origin}/api/auth/teams/callback`

  const authorizeUrl = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(cfg.azure_tenant_id)}/oauth2/v2.0/authorize`
  )
  authorizeUrl.searchParams.set('client_id', cfg.azure_client_id)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('response_mode', 'query')
  authorizeUrl.searchParams.set('scope', TEAMS_OAUTH_SCOPES)
  authorizeUrl.searchParams.set('state', nonce)
  authorizeUrl.searchParams.set('prompt', 'select_account')

  return NextResponse.redirect(authorizeUrl.toString(), { status: 302 })
}
