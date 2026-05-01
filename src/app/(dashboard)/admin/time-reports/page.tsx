/**
 * /admin/time-reports — agent time-tracking dashboard.
 *
 * Server component, force-dynamic. Pulls data with the service-role client
 * (RLS would already scope reads, but we run a deliberate scope-by-company
 * pass here so the queries stay cheap and the page can also serve
 * super_admins viewing arbitrary companies in future).
 *
 * Layout:
 *   1. Per-agent table — rows ranked by time today / this week / this month.
 *   2. Top 10 conversations by total time across all users (last 30 days).
 *   3. Average time per conversation by status.
 */

import { redirect } from 'next/navigation'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { isCompanyAdmin } from '@/lib/auth'
import { Card } from '@/components/ui/card'
import { aggregateForCompany } from '@/lib/time-tracking'

export const dynamic = 'force-dynamic'

interface TimeRow {
  user_id: string
  conversation_id: string
  account_id: string
  duration_seconds: number | null
  started_at: string
  ended_at: string | null
}

function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '0m'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMin = mins % 60
  if (hrs < 24) return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`
  const days = Math.floor(hrs / 24)
  const remHr = hrs % 24
  return remHr > 0 ? `${days}d ${remHr}h` : `${days}d`
}

function startOfTodayUtc(): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

function startOfWeekUtc(): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  // ISO week, treat Monday = 1. JS getUTCDay returns 0 for Sunday.
  const dow = d.getUTCDay()
  const offset = dow === 0 ? 6 : dow - 1
  d.setUTCDate(d.getUTCDate() - offset)
  return d.toISOString()
}

function startOfMonthUtc(): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(1)
  return d.toISOString()
}

function startOfNDaysAgoUtc(n: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString()
}

/** Same elapsed-seconds rule the helper uses, kept here so the page can
 *  do its own status / conversation rollups without re-fetching. */
function rowSeconds(r: TimeRow): number {
  if (typeof r.duration_seconds === 'number') return r.duration_seconds
  const startMs = Date.parse(r.started_at)
  const endMs = r.ended_at ? Date.parse(r.ended_at) : Date.now()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0
  const d = Math.floor((endMs - startMs) / 1000)
  return d > 0 ? d : 0
}

export default async function TimeReportsPage() {
  // ── Auth gate ────────────────────────────────────────────────────
  const supabase = await createServerSupabaseClient()
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()
  if (!authUser) redirect('/login')

  const { data: profile } = await supabase
    .from('users')
    .select('id, role, company_id')
    .eq('id', authUser.id)
    .maybeSingle()
  const role = (profile?.role ?? '') as string
  if (!isCompanyAdmin(role)) redirect('/dashboard')

  const companyId = (profile as { company_id: string | null } | null)?.company_id ?? null

  // Super_admin without a company sees no rollup — they can pick one
  // through an account view in future. Render an empty-state hint.
  if (!companyId) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-semibold text-gray-900 mb-4">Time reports</h1>
        <Card>
          <div className="p-6 text-sm text-gray-600">
            Your account isn&apos;t associated with a company yet, so there is
            no time data to roll up. Assign yourself to a company in
            <span className="font-medium"> Admin → Users</span> to see reports.
          </div>
        </Card>
      </div>
    )
  }

  const admin = await createServiceRoleClient()

  // ── Per-agent rankings (today / week / month) ────────────────────
  const [todayRows, weekRows, monthRows] = await Promise.all([
    aggregateForCompany(admin, companyId, startOfTodayUtc()),
    aggregateForCompany(admin, companyId, startOfWeekUtc()),
    aggregateForCompany(admin, companyId, startOfMonthUtc()),
  ])

  // Resolve names for everyone in any of the three lists.
  const allUserIds = Array.from(
    new Set([
      ...todayRows.map((r) => r.user_id),
      ...weekRows.map((r) => r.user_id),
      ...monthRows.map((r) => r.user_id),
    ])
  )
  const nameById = new Map<string, string>()
  if (allUserIds.length > 0) {
    const { data: users } = await admin
      .from('users')
      .select('id, full_name, email')
      .in('id', allUserIds)
    for (const u of (users ?? []) as Array<{
      id: string
      full_name: string | null
      email: string | null
    }>) {
      nameById.set(u.id, u.full_name || u.email || 'Unknown')
    }
  }

  // Combine into a single per-agent table keyed by user_id.
  const agentTable = new Map<
    string,
    { name: string; today: number; week: number; month: number }
  >()
  for (const r of monthRows) {
    agentTable.set(r.user_id, {
      name: nameById.get(r.user_id) ?? 'Unknown',
      today: 0,
      week: 0,
      month: r.total_seconds,
    })
  }
  for (const r of weekRows) {
    const cur = agentTable.get(r.user_id) ?? {
      name: nameById.get(r.user_id) ?? 'Unknown',
      today: 0,
      week: 0,
      month: 0,
    }
    cur.week = r.total_seconds
    agentTable.set(r.user_id, cur)
  }
  for (const r of todayRows) {
    const cur = agentTable.get(r.user_id) ?? {
      name: nameById.get(r.user_id) ?? 'Unknown',
      today: 0,
      week: 0,
      month: 0,
    }
    cur.today = r.total_seconds
    agentTable.set(r.user_id, cur)
  }
  const agentRanking = Array.from(agentTable.entries())
    .map(([user_id, v]) => ({ user_id, ...v }))
    .sort((a, b) => b.month - a.month)

  // ── Top 10 conversations by total time (last 30 days) ────────────
  const since30 = startOfNDaysAgoUtc(30)

  const { data: companyAccounts } = await admin
    .from('accounts')
    .select('id')
    .eq('company_id', companyId)
  const accountIds = (companyAccounts ?? []).map((a: { id: string }) => a.id)

  let topConversations: Array<{
    conversation_id: string
    total_seconds: number
    participant: string
    status: string | null
  }> = []
  let avgByStatus: Array<{ status: string; avg_seconds: number; conversations: number }> = []

  if (accountIds.length > 0) {
    const { data: rangeData } = await admin
      .from('conversation_time_entries')
      .select('user_id, conversation_id, account_id, duration_seconds, started_at, ended_at')
      .in('account_id', accountIds)
      .gte('started_at', since30)
    const rows = (rangeData ?? []) as TimeRow[]

    const byConv = new Map<string, number>()
    for (const r of rows) {
      byConv.set(r.conversation_id, (byConv.get(r.conversation_id) ?? 0) + rowSeconds(r))
    }
    const sortedConvIds = Array.from(byConv.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
    if (sortedConvIds.length > 0) {
      const ids = sortedConvIds.map(([id]) => id)
      const { data: convs } = await admin
        .from('conversations')
        .select('id, participant_name, participant_email, status')
        .in('id', ids)
      const meta = new Map<
        string,
        { name: string; status: string | null }
      >()
      for (const c of (convs ?? []) as Array<{
        id: string
        participant_name: string | null
        participant_email: string | null
        status: string | null
      }>) {
        meta.set(c.id, {
          name: c.participant_name || c.participant_email || 'Unknown',
          status: c.status,
        })
      }
      topConversations = sortedConvIds.map(([id, total_seconds]) => ({
        conversation_id: id,
        total_seconds,
        participant: meta.get(id)?.name ?? 'Unknown',
        status: meta.get(id)?.status ?? null,
      }))
    }

    // Avg time per conversation by status — pull every conversation in the
    // company that had at least one entry in the window. Group by status.
    if (byConv.size > 0) {
      const allConvIds = Array.from(byConv.keys())
      const { data: convs } = await admin
        .from('conversations')
        .select('id, status')
        .in('id', allConvIds)
      const statusById = new Map<string, string>()
      for (const c of (convs ?? []) as Array<{ id: string; status: string | null }>) {
        statusById.set(c.id, c.status ?? 'unknown')
      }
      const byStatus = new Map<string, { total: number; count: number }>()
      for (const [convId, total] of byConv.entries()) {
        const status = statusById.get(convId) ?? 'unknown'
        const cur = byStatus.get(status) ?? { total: 0, count: 0 }
        cur.total += total
        cur.count += 1
        byStatus.set(status, cur)
      }
      avgByStatus = Array.from(byStatus.entries())
        .map(([status, v]) => ({
          status,
          avg_seconds: v.count > 0 ? Math.round(v.total / v.count) : 0,
          conversations: v.count,
        }))
        .sort((a, b) => b.avg_seconds - a.avg_seconds)
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Time reports</h1>
        <p className="text-sm text-gray-600 mt-1">
          Per-agent time tracking and conversation effort across your company.
        </p>
      </div>

      {/* Per-agent table */}
      <Card>
        <div className="p-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Per-agent totals</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Total tracked time per agent. Includes auto + manual entries.
          </p>
        </div>
        {agentRanking.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">
            No tracked time in the current month yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left">Agent</th>
                  <th className="px-4 py-2 text-right">Today</th>
                  <th className="px-4 py-2 text-right">This week</th>
                  <th className="px-4 py-2 text-right">This month</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {agentRanking.map((row) => (
                  <tr key={row.user_id}>
                    <td className="px-4 py-2 text-gray-900">{row.name}</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-700">
                      {formatDuration(row.today)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-700">
                      {formatDuration(row.week)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-900 font-semibold">
                      {formatDuration(row.month)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Top conversations */}
      <Card>
        <div className="p-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">
            Top 10 conversations (last 30 days)
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Conversations consuming the most agent effort across your accounts.
          </p>
        </div>
        {topConversations.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">
            No tracked time on any conversations in the last 30 days.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left">Conversation</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-right">Total time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {topConversations.map((row) => (
                  <tr key={row.conversation_id}>
                    <td className="px-4 py-2">
                      <a
                        href={`/conversations/${row.conversation_id}`}
                        className="text-teal-700 hover:underline"
                      >
                        {row.participant}
                      </a>
                    </td>
                    <td className="px-4 py-2 text-gray-700">
                      {row.status ?? 'unknown'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-900 font-semibold">
                      {formatDuration(row.total_seconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Average by status */}
      <Card>
        <div className="p-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">
            Average time per conversation, by status
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Last 30 days. Helps spot statuses where conversations linger.
          </p>
        </div>
        {avgByStatus.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">No data yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-right">Conversations</th>
                  <th className="px-4 py-2 text-right">Avg time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {avgByStatus.map((row) => (
                  <tr key={row.status}>
                    <td className="px-4 py-2 text-gray-900">{row.status}</td>
                    <td className="px-4 py-2 text-right text-gray-700">
                      {row.conversations}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-900 font-semibold">
                      {formatDuration(row.avg_seconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
