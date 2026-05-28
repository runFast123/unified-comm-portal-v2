import { NextResponse } from 'next/server'
import { cookies, headers } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import { getIntegrationStatus } from '@/lib/integration-settings'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/health/oauth
 *
 * Admin-only. Returns:
 *   1. Current Google + Azure OAuth integration statuses (source, last4, last_tested_at)
 *      for the caller's active company. Integrations are PER-COMPANY (see
 *      migration 20260528170000), so super_admin sees the cookie-selected
 *      company and company_admin sees their own.
 *   2. The EXACT redirect URIs that should be registered in the Google Cloud
 *      console / Azure App Registration. These are derived from the inbound
 *      request headers so the value matches whatever host the admin used to
 *      reach this page (preview deploys, custom domains, localhost — all work).
 *
 * The redirect-URI helper is the killer feature: a misconfigured callback URL
 * was the single biggest source of OAuth setup pain ("redirect_uri_mismatch"
 * with no hint as to what value the OAuth provider was expecting).
 */
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
  return { ok: true as const, companyId }
}

/**
 * Build the public origin for this request. Prefers x-forwarded-* headers
 * (Vercel's edge sets these correctly even when the runtime sees an
 * internal hostname), falls back to host.
 */
async function detectOrigin(): Promise<string> {
  const h = await headers()
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  return `${proto}://${host}`
}

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const origin = await detectOrigin()

  // Without a resolved company we can't look up integration_settings rows
  // (every row is per-company). Surface that as a 'none' source instead of
  // throwing — the redirect-URI hints are still useful.
  if (!gate.companyId) {
    return NextResponse.json({
      integrations: {
        google_oauth: {
          source: 'none',
          last_tested_at: null,
          last_tested_ok: null,
          client_id_last4: null,
        },
        azure_oauth: {
          source: 'none',
          last_tested_at: null,
          last_tested_ok: null,
          client_id_last4: null,
        },
      },
      redirect_uris: {
        gmail: `${origin}/api/auth/gmail/callback`,
        teams: `${origin}/api/auth/teams/callback`,
      },
      detected_origin: origin,
      company_id: null,
    })
  }

  const [google, azure] = await Promise.all([
    getIntegrationStatus('google_oauth', gate.companyId),
    getIntegrationStatus('azure_oauth', gate.companyId),
  ])

  return NextResponse.json({
    integrations: {
      google_oauth: google,
      azure_oauth: azure,
    },
    redirect_uris: {
      // These paths must stay in lockstep with the actual route handlers
      // at src/app/api/auth/gmail/callback/route.ts and
      // src/app/api/auth/teams/callback/route.ts.
      gmail: `${origin}/api/auth/gmail/callback`,
      teams: `${origin}/api/auth/teams/callback`,
    },
    detected_origin: origin,
    company_id: gate.companyId,
  })
}
