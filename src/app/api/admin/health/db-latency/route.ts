import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/health/db-latency
 *
 * Admin-only. Issues the cheapest possible Supabase query (HEAD /accounts
 * with limit=1 — translates to a primary-key index lookup) and reports
 * round-trip ms. Useful for catching regional misconfigs (e.g. portal
 * deployed in iad1 but Supabase project in syd1) and for distinguishing
 * "is the DB slow" from "is the API route slow" when investigating a
 * stalled inbox.
 *
 * NOTE: We deliberately use a query, not `select 1`. There is no Supabase
 * RPC for raw SQL via the REST endpoint, and a HEAD against an existing
 * table avoids hauling any rows back over the wire.
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

  const admin = await createServiceRoleClient()

  // Run three sequential trips so we can report a stable read rather than
  // a single noisy spike. Picking the median trims warm-up jitter.
  const samples: number[] = []
  let firstError: string | null = null
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    const { error } = await admin.from('accounts').select('id', { count: 'exact', head: true })
    const elapsed = performance.now() - start
    if (error && !firstError) firstError = error.message
    samples.push(elapsed)
  }

  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]
  const min = samples[0]
  const max = samples[samples.length - 1]

  return NextResponse.json({
    ok: !firstError,
    error: firstError,
    samples_ms: samples.map((n) => Math.round(n)),
    median_ms: Math.round(median),
    min_ms: Math.round(min),
    max_ms: Math.round(max),
    sampled_at: new Date().toISOString(),
  })
}
