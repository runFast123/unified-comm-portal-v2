import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getGoogleOAuth, getAzureOAuth } from '@/lib/integration-settings'

export const dynamic = 'force-dynamic'

async function requireAdmin() {
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
  if (!['admin','super_admin','company_admin'].includes(profile?.role ?? '')) return { ok: false as const, status: 403, error: 'Admin only' }
  return {
    ok: true as const,
    companyId: (profile?.company_id as string | null) ?? null,
  }
}

/**
 * GET /api/auth/availability
 *
 * Reports which OAuth providers the create-flow can offer out-of-the-box
 * for the CALLER's active company. OAuth client creds are per-company
 * (see migration 20260528170000), so availability depends on which
 * company we look up:
 *   - super_admin → cookie-selected company (or null = combined view, in
 *     which case we report unavailable since there's no tenant to scope to)
 *   - company_admin → their own company
 *
 *   gmail — true when this company has Google OAuth creds configured,
 *           either in integration_settings (admin UI) or via
 *           GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET env vars.
 *
 *   teams — true when this company has Azure OAuth creds configured in
 *           integration_settings or via AZURE_TENANT_ID + AZURE_CLIENT_ID
 *           + AZURE_CLIENT_SECRET env vars (shared Azure app
 *           registration). Without those, Teams OAuth is unavailable
 *           during create because the callback needs them to exchange
 *           the auth code.
 */
export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  // Resolve which company to check creds for. Cookie wins for super_admin
  // (switcher selection); fall back to the caller's home company.
  const cookieStore = await cookies()
  const cookieCompanyId = cookieStore.get('selected_company_id')?.value ?? null
  const companyId = cookieCompanyId || gate.companyId

  if (!companyId) {
    // super_admin in combined view with no cookie — no tenant to scope to.
    // Report unavailable rather than misleadingly using env fallback for an
    // unspecified tenant.
    return NextResponse.json({ gmail: false, teams: false })
  }

  // DB-first, env fallback — same resolution as every other caller of the
  // integration-settings helpers.
  const [google, azure] = await Promise.all([
    getGoogleOAuth(companyId),
    getAzureOAuth(companyId),
  ])

  return NextResponse.json({
    gmail: Boolean(google),
    teams: Boolean(azure),
  })
}
