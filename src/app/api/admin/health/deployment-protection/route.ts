import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/health/deployment-protection
 *
 * Admin-only. Server-to-server fetches our OWN `/api/test-connection`
 * endpoint without forwarding the user's auth cookie. If Vercel
 * "Deployment Protection" is enabled the response will be the SSO HTML
 * gate page (Content-Type text/html) instead of our JSON payload — and
 * every external integration (cron jobs, webhooks, OAuth callbacks)
 * will silently fail because they hit the same wall.
 *
 * This is the single most common "everything is broken on prod but works
 * locally" symptom. Surfacing it explicitly saves hours of bisecting.
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

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const h = await headers()
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const probeUrl = `${proto}://${host}/api/test-connection`

  let status = 0
  let contentType = ''
  let snippet = ''
  let blocked = false
  let fetchError: string | null = null
  try {
    // Deliberately UNAUTHENTICATED — that's the whole point: we want to see
    // what an external caller (cron, webhook, OAuth provider) would see.
    const res = await fetch(probeUrl, {
      method: 'GET',
      cache: 'no-store',
      // 8s gives Vercel time to cold-start without hanging the page.
      signal: AbortSignal.timeout(8000),
    })
    status = res.status
    contentType = res.headers.get('content-type') ?? ''

    // Read a small snippet so we can show diagnostic context without
    // streaming megabytes back through the API.
    try {
      const text = await res.text()
      snippet = text.slice(0, 200)
    } catch {
      snippet = ''
    }

    // Heuristic: if the body is HTML — regardless of status — Vercel SSO is
    // intercepting. Our /api/test-connection always returns JSON, so HTML
    // here is unambiguously the gate page.
    blocked =
      contentType.toLowerCase().includes('text/html') ||
      /vercel\s*authentication|sso\s*provider|deployment\s+protection/i.test(snippet)
  } catch (err) {
    fetchError = err instanceof Error ? err.message : 'fetch failed'
  }

  return NextResponse.json({
    probe_url: probeUrl,
    status,
    content_type: contentType,
    snippet,
    blocked,
    fetch_error: fetchError,
    checked_at: new Date().toISOString(),
  })
}
