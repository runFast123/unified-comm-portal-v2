import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { pollAllEmailAccounts, pollEmailAccountsFor } from '@/lib/email-poller'
import { pollAllTeamsAccounts, pollTeamsAccountsFor } from '@/lib/teams-poller'
import { getAllowedAccountIds, isSuperAdmin } from '@/lib/auth'

// In-flight guard to stop users double-firing the pollers from the UI.
// (Process-level; resets on server restart.)
let running = false
let lastRunAt = 0
const MIN_INTERVAL_MS = 20_000

/**
 * POST /api/inbox-sync
 *   Session-authenticated. Fires both email and teams pollers in the background
 *   and returns immediately. New messages land in the UI via Supabase realtime.
 *
 *   Exists because Vercel Cron only runs on the deployed environment; in dev
 *   (and whenever a user clicks "Sync now") we need an in-app trigger.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Account scope: in a multi-tenant deploy a non-admin user triggering sync
  // must NOT kick off IMAP/Graph polls on other customers' accounts. Look up
  // their role + account_id (same gate used by /api/send).
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role, account_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile) return NextResponse.json({ error: 'User profile not found' }, { status: 403 })

  const now = Date.now()
  if (running) {
    return NextResponse.json({ started: false, reason: 'already_running' })
  }
  if (now - lastRunAt < MIN_INTERVAL_MS) {
    return NextResponse.json({
      started: false,
      reason: 'throttled',
      retry_in_ms: MIN_INTERVAL_MS - (now - lastRunAt),
    })
  }

  // super_admin polls everything (cross-tenant). Everyone else (company
  // admins, company members, legacy single-account users) is scoped to the
  // accounts in their company / their single account.
  const isSuper = isSuperAdmin(profile.role)
  let scopedIds: string[] = []
  if (!isSuper) {
    const allowed = await getAllowedAccountIds(user.id)
    scopedIds = allowed ? Array.from(allowed) : []
    if (scopedIds.length === 0) {
      return NextResponse.json({ started: false, reason: 'no_account' })
    }
  }

  running = true
  lastRunAt = now
  const origin = new URL(request.url).origin

  // Kick off both pollers; don't block the response.
  ;(async () => {
    try {
      if (isSuper) {
        await Promise.allSettled([
          pollAllEmailAccounts(origin),
          pollAllTeamsAccounts(origin),
        ])
      } else {
        await Promise.allSettled([
          pollEmailAccountsFor(scopedIds, origin),
          pollTeamsAccountsFor(scopedIds, origin),
        ])
      }
    } catch (err) {
      console.error('inbox-sync poll failed:', err)
    } finally {
      running = false
    }
  })()

  return NextResponse.json({ started: true })
}
