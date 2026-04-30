import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getIntegrationStatus } from '@/lib/integration-settings'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/health/oauth
 *
 * Admin-only. Returns:
 *   1. Current Google + Azure OAuth integration statuses (source, last4, last_tested_at)
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
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  if (profile?.role !== 'admin') return { ok: false as const, status: 403, error: 'Admin only' }
  return { ok: true as const }
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

  const [google, azure] = await Promise.all([
    getIntegrationStatus('google_oauth'),
    getIntegrationStatus('azure_oauth'),
  ])

  const origin = await detectOrigin()

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
  })
}
