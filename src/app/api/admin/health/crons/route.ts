import { NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/health/crons
 *
 * Admin-only. Reads `vercel.json` at request time and returns the cron
 * schedule list, then enriches polling-related crons with the most
 * recent `accounts.last_polled_at` so the operator can see whether the
 * job has actually run lately. (Vercel doesn't expose cron run history
 * to the runtime — comparing wall clock to last poll timestamp is the
 * best signal we have without the Vercel API.)
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

interface CronEntry {
  path: string
  schedule: string
  /** Channel inferred from the path — used by the UI to fetch poll-recency
   *  data for matching account groups. NULL for non-polling crons (e.g.
   *  dispatch-scheduled). */
  channel: 'email' | 'teams' | null
}

interface VercelCron {
  path: string
  schedule: string
}

interface VercelJson {
  crons?: VercelCron[]
}

function inferChannel(p: string): 'email' | 'teams' | null {
  if (p.includes('email-poll')) return 'email'
  if (p.includes('teams-poll')) return 'teams'
  return null
}

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  // Read vercel.json from the project root. process.cwd() is the right anchor
  // both in `next dev` and in the Vercel runtime.
  let crons: CronEntry[] = []
  let vercelJsonError: string | null = null
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'vercel.json'), 'utf8')
    const parsed = JSON.parse(raw) as VercelJson
    crons = (parsed.crons ?? []).map((c) => ({
      path: c.path,
      schedule: c.schedule,
      channel: inferChannel(c.path),
    }))
  } catch (err) {
    vercelJsonError = err instanceof Error ? err.message : 'Failed to read vercel.json'
  }

  // For each polling channel we surface MAX(last_polled_at) across that
  // channel's accounts — that's the freshest signal that ANY shard ran.
  // We also surface MIN to catch accounts that got stranded by a broken
  // shard rotation.
  const admin = await createServiceRoleClient()
  const channelStats: Record<'email' | 'teams', { max_last_polled_at: string | null; min_last_polled_at: string | null; account_count: number } | null> = {
    email: null,
    teams: null,
  }

  for (const channel of ['email', 'teams'] as const) {
    const { data, error } = await admin
      .from('accounts')
      .select('last_polled_at')
      .eq('channel_type', channel)
      .eq('is_active', true)
    if (error || !data) {
      channelStats[channel] = null
      continue
    }
    const stamps = data
      .map((r) => (r.last_polled_at ? new Date(r.last_polled_at).getTime() : null))
      .filter((n): n is number => n != null)
    channelStats[channel] = {
      max_last_polled_at: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
      min_last_polled_at: stamps.length ? new Date(Math.min(...stamps)).toISOString() : null,
      account_count: data.length,
    }
  }

  return NextResponse.json({
    vercel_json_error: vercelJsonError,
    crons,
    channel_stats: channelStats,
    server_time: new Date().toISOString(),
  })
}
