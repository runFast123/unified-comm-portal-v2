import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { queueHealthSnapshot } from '@/lib/dispatch-reaper'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/health/queues
 *
 * Admin-only. Backlog depth + stranded-claim counts for the two outbound
 * queues (`scheduled_messages`, `pending_sends`).
 *
 * The crons card next door proves the dispatcher RUNS; it says nothing about
 * whether the queues it drains are actually draining. A dispatcher that runs
 * every minute and strands every row it touches looks perfectly healthy there.
 * This is the counterpart: queue depth, how far behind the oldest due row is,
 * and how many rows are stuck mid-claim.
 *
 * Counts span every tenant by design — this is the operator's view, same as
 * the rest of /admin/health.
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
  if (!['admin', 'super_admin', 'company_admin'].includes(profile?.role ?? '')) {
    return { ok: false as const, status: 403, error: 'Admin only' }
  }
  return { ok: true as const }
}

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = await createServiceRoleClient()
  const report = await queueHealthSnapshot(admin)
  return NextResponse.json(report)
}
