import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import {
  getGoogleOAuth,
  getAzureOAuth,
  markIntegrationTested,
  type IntegrationKey,
} from '@/lib/integration-settings'

export const dynamic = 'force-dynamic'

/**
 * Admin gate — mirrors `../route.ts`. Integrations are PER-COMPANY now
 * (migration 20260528170000), so company_admin gets access scoped to
 * their own tenant and super_admin scopes via the switcher cookie.
 */
async function requireIntegrationsAdmin() {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role, company_id')
    .eq('id', user.id)
    .maybeSingle()
  const role = profile?.role ?? null
  const homeCompanyId = (profile?.company_id as string | null) ?? null
  if (!isSuperAdmin(role) && !isCompanyAdmin(role)) {
    return { ok: false as const, status: 403, error: 'Admin only' }
  }
  let companyId: string | null
  if (isSuperAdmin(role)) {
    const cookieStore = await cookies()
    companyId = (cookieStore.get('selected_company_id')?.value ?? null) || homeCompanyId
  } else {
    companyId = homeCompanyId
  }
  if (!companyId) {
    return {
      ok: false as const,
      status: 400,
      error: 'No active company selected — pick a tenant in the company switcher.',
    }
  }
  return { ok: true as const, userId: user.id, companyId }
}

interface TestResult {
  ok: boolean
  error?: string
}

interface GoogleTokenErrorBody {
  error?: string
  error_description?: string
}

interface AzureTokenBody {
  access_token?: string
  error?: string
  error_description?: string
}

/**
 * Google validation strategy:
 * POST to the token endpoint with grant_type=authorization_code and an
 * obviously-invalid code. Google validates the client credentials BEFORE
 * checking the code, so:
 *
 *   invalid_client  → client_id / client_secret are wrong  → creds FAIL
 *   invalid_grant   → creds are valid, code is just wrong  → creds OK
 *
 * Any other error we surface verbatim (for setup typos, network, etc.).
 * We never echo the client_secret back to the caller.
 */
async function testGoogle(
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<TestResult> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code: 'invalid',
        // Use our real registered callback. Using e.g. 'http://localhost'
        // would short-circuit with redirect_uri_mismatch on Google's side
        // before it even checks the client credentials — so invalid_client
        // would never be reached and the test would miss bad creds.
        redirect_uri: redirectUri,
      }),
    })
    let body: GoogleTokenErrorBody = {}
    try {
      body = (await res.json()) as GoogleTokenErrorBody
    } catch {
      return { ok: false, error: `Google returned ${res.status} with non-JSON body` }
    }
    if (body.error === 'invalid_grant') {
      // Credentials validated; only the code is bad (expected).
      return { ok: true }
    }
    if (body.error === 'invalid_client') {
      return { ok: false, error: 'Client ID or Client Secret is incorrect' }
    }
    // Fall-through: surface Google's message for clarity (e.g. unauthorized_client).
    const description = body.error_description || body.error || 'Unknown error'
    return { ok: false, error: `Google: ${description}` }
  } catch (err) {
    return {
      ok: false,
      error: `Network error contacting Google: ${err instanceof Error ? err.message : 'unknown'}`,
    }
  }
}

/**
 * Azure validation strategy:
 * client_credentials flow against the tenant's token endpoint with the
 * Graph .default scope. If Microsoft returns an access_token the app
 * registration + secret are valid for this tenant. We don't log or return
 * the token itself.
 */
async function testAzure(
  tenantId: string,
  clientId: string,
  clientSecret: string
): Promise<TestResult> {
  try {
    const res = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        }),
      }
    )
    let body: AzureTokenBody = {}
    try {
      body = (await res.json()) as AzureTokenBody
    } catch {
      return { ok: false, error: `Azure returned ${res.status} with non-JSON body` }
    }
    if (res.ok && typeof body.access_token === 'string' && body.access_token.length > 0) {
      return { ok: true }
    }
    const description = body.error_description || body.error || `HTTP ${res.status}`
    return { ok: false, error: `Azure: ${description}` }
  } catch (err) {
    return {
      ok: false,
      error: `Network error contacting Azure: ${err instanceof Error ? err.message : 'unknown'}`,
    }
  }
}

function isIntegrationKey(v: unknown): v is IntegrationKey {
  return v === 'google_oauth' || v === 'azure_oauth'
}

export async function POST(request: Request) {
  const gate = await requireIntegrationsAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: { key?: unknown; config?: unknown }
  try {
    body = (await request.json()) as { key?: unknown; config?: unknown }
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  if (!isIntegrationKey(body.key)) {
    return NextResponse.json(
      { error: 'key must be google_oauth or azure_oauth' },
      { status: 400 }
    )
  }
  const key: IntegrationKey = body.key
  const hasInlineConfig = body.config !== undefined && body.config !== null

  let result: TestResult

  if (key === 'google_oauth') {
    let clientId = ''
    let clientSecret = ''
    if (hasInlineConfig) {
      const c = body.config as Record<string, unknown>
      if (typeof c.client_id !== 'string' || typeof c.client_secret !== 'string') {
        return NextResponse.json(
          { error: 'config.client_id and config.client_secret must be strings' },
          { status: 400 }
        )
      }
      clientId = c.client_id.trim()
      clientSecret = c.client_secret.trim()
      if (!clientId || !clientSecret) {
        return NextResponse.json(
          { error: 'client_id and client_secret must not be empty' },
          { status: 400 }
        )
      }
    } else {
      const creds = await getGoogleOAuth(gate.companyId)
      if (!creds) {
        return NextResponse.json(
          { ok: false, error: 'Google OAuth is not configured for this company (no DB row and no env vars).' }
        )
      }
      clientId = creds.client_id
      clientSecret = creds.client_secret
    }
    const origin = new URL(request.url).origin
    const redirectUri = `${origin}/api/auth/gmail/callback`
    result = await testGoogle(clientId, clientSecret, redirectUri)
  } else {
    let tenantId = ''
    let clientId = ''
    let clientSecret = ''
    if (hasInlineConfig) {
      const c = body.config as Record<string, unknown>
      if (
        typeof c.tenant_id !== 'string' ||
        typeof c.client_id !== 'string' ||
        typeof c.client_secret !== 'string'
      ) {
        return NextResponse.json(
          { error: 'config.tenant_id, client_id, client_secret must be strings' },
          { status: 400 }
        )
      }
      tenantId = c.tenant_id.trim()
      clientId = c.client_id.trim()
      clientSecret = c.client_secret.trim()
      if (!tenantId || !clientId || !clientSecret) {
        return NextResponse.json(
          { error: 'tenant_id, client_id, client_secret must not be empty' },
          { status: 400 }
        )
      }
    } else {
      const creds = await getAzureOAuth(gate.companyId)
      if (!creds) {
        return NextResponse.json(
          { ok: false, error: 'Azure OAuth is not configured for this company (no DB row and no env vars).' }
        )
      }
      tenantId = creds.tenant_id
      clientId = creds.client_id
      clientSecret = creds.client_secret
    }
    result = await testAzure(tenantId, clientId, clientSecret)
  }

  // Persist test outcome ONLY when testing saved creds (no inline config).
  // A one-off test of unsaved form values shouldn't touch the DB row.
  if (!hasInlineConfig) {
    try {
      await markIntegrationTested(key, result.ok, gate.companyId)
    } catch (err) {
      // Non-fatal — the test result is still authoritative for the caller.
      console.error('Failed to persist test outcome:', err)
    }
  }

  return NextResponse.json(result)
}
