/**
 * /admin/csat — CSAT (customer satisfaction) dashboard.
 *
 * Server component (force-dynamic). Three blocks:
 *   1. Company-wide rollup for the last 30 days.
 *   2. 12-week trend (inline SVG bar chart, no chart lib).
 *   3. Per-agent ranking table with optional drill-in (?agent=<userId>).
 *
 * Auth: admin layout already enforces company_admin / super_admin. We
 * additionally pin the company scope to the caller's company unless they
 * are super_admin (in which case they see their own company's data —
 * cross-tenant browsing isn't part of MVP).
 */

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser } from '@/lib/auth'
import { companyCSATAggregate, agentCSATAggregate, type CSATAggregate } from '@/lib/csat'
import { Card } from '@/components/ui/card'

export const dynamic = 'force-dynamic'

interface SurveyJoinRow {
  id: string
  agent_user_id: string | null
  rating: number | null
  responded_at: string | null
  sent_at: string
  feedback: string | null
  conversation_id: string
  customer_email: string | null
}

interface UserNameRow {
  id: string
  full_name: string | null
  email: string
}

interface AgentRow {
  user_id: string
  name: string
  email: string
  sent: number
  responded: number
  avg: number
  last7Avg: number
}

function fmtRating(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n.toFixed(2)
}
function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '0%'
  return `${Math.round(n * 100)}%`
}

function ratingEmoji(rating: number): string {
  return ['', '😡', '😕', '😐', '🙂', '😍'][Math.round(rating)] ?? ''
}

export default async function CSATAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>
}) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const profile = await getCurrentUser(user.id)
  if (!profile?.company_id) {
    return (
      <div className="p-6">
        <Card className="p-6">
          <h1 className="text-lg font-semibold mb-2">CSAT</h1>
          <p className="text-sm text-gray-500">
            Your account isn&apos;t attached to a company yet. Ask an admin to
            assign you so this dashboard can scope the data.
          </p>
        </Card>
      </div>
    )
  }

  const admin = await createServiceRoleClient()
  const companyId = profile.company_id
  const sp = await searchParams
  const agentId = sp?.agent ?? null

  // ── 30-day company rollup ────────────────────────────────────────
  const dateFrom30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const companyAgg = await companyCSATAggregate(admin, companyId, dateFrom30)

  // ── 12-week trend (one bar per week) ─────────────────────────────
  const trendStart = new Date(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000)
  const { data: accounts12 } = await admin
    .from('accounts')
    .select('id')
    .eq('company_id', companyId)
  const accountIds12: string[] = (accounts12 ?? []).map((a: { id: string }) => a.id)

  const { data: trendRows } = accountIds12.length
    ? await admin
        .from('csat_surveys')
        .select('rating, responded_at, sent_at')
        .in('account_id', accountIds12)
        .gte('sent_at', trendStart.toISOString())
        .order('sent_at', { ascending: true })
    : { data: [] as Array<{ rating: number | null; responded_at: string | null; sent_at: string }> }

  const weekly = bucketWeekly(trendRows ?? [], trendStart)

  // ── Per-agent ranking ───────────────────────────────────────────
  const dateFrom7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const { data: surveys30 } = accountIds12.length
    ? await admin
        .from('csat_surveys')
        .select('id, agent_user_id, rating, responded_at, sent_at, feedback, conversation_id, customer_email')
        .in('account_id', accountIds12)
        .gte('sent_at', dateFrom30.toISOString())
        .order('sent_at', { ascending: false })
    : { data: [] as SurveyJoinRow[] }

  const agentRows: AgentRow[] = await rollupByAgent(
    admin,
    (surveys30 ?? []) as SurveyJoinRow[],
    dateFrom7
  )

  // ── Drill-in (?agent=<id>) ───────────────────────────────────────
  let agentDrill: {
    user: UserNameRow | null
    aggregate: CSATAggregate
    surveys: SurveyJoinRow[]
  } | null = null
  if (agentId) {
    const { data: au } = await admin
      .from('users')
      .select('id, full_name, email')
      .eq('id', agentId)
      .maybeSingle()
    const surveysForAgent = (surveys30 ?? []).filter(
      (s: SurveyJoinRow) => s.agent_user_id === agentId
    )
    const aggregate = await agentCSATAggregate(admin, agentId, dateFrom30)
    agentDrill = {
      user: (au as UserNameRow | null) ?? null,
      aggregate,
      surveys: surveysForAgent,
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Customer satisfaction</h1>
          <p className="text-sm text-gray-500 mt-1">
            Rolling 30-day rollup for {profile.email}&apos;s company. Surveys
            auto-send when a conversation is marked resolved
            (configurable per company).
          </p>
        </div>
      </div>

      {/* Top KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label="Average rating" value={fmtRating(companyAgg.avg_rating)} suffix={companyAgg.avg_rating > 0 ? `/ 5 ${ratingEmoji(companyAgg.avg_rating)}` : ''} />
        <Kpi label="Surveys sent" value={String(companyAgg.total_sent)} />
        <Kpi label="Responded" value={String(companyAgg.total_responded)} />
        <Kpi label="Response rate" value={fmtPct(companyAgg.response_rate)} />
      </div>

      {/* Distribution */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Rating distribution (last 30d)</h2>
        <Distribution distribution={companyAgg.distribution} />
      </Card>

      {/* 12-week trend */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">12-week trend</h2>
        <TrendChart weekly={weekly} />
      </Card>

      {/* Per-agent ranking */}
      <Card className="p-0 overflow-hidden">
        <div className="p-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">Per-agent ranking</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Click an agent to drill into their individual responses + feedback.
          </p>
        </div>
        {agentRows.length === 0 ? (
          <div className="p-6 text-sm text-gray-500 text-center">
            No CSAT responses yet. Once a conversation is resolved with the
            company-level CSAT toggle on, surveys will land here.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Agent</th>
                <th className="text-right px-4 py-2">Sent</th>
                <th className="text-right px-4 py-2">Response rate</th>
                <th className="text-right px-4 py-2">Avg rating</th>
                <th className="text-right px-4 py-2">Last 7d avg</th>
                <th className="text-right px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {agentRows.map((row) => (
                <tr key={row.user_id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <div className="font-medium text-gray-900">{row.name}</div>
                    <div className="text-xs text-gray-500">{row.email}</div>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.sent}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtPct(row.sent === 0 ? 0 : row.responded / row.sent)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtRating(row.avg)} {row.avg > 0 && <span>{ratingEmoji(row.avg)}</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtRating(row.last7Avg)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      href={`/admin/csat?agent=${row.user_id}`}
                      className="text-teal-700 hover:underline text-xs font-medium"
                    >
                      Drill in →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Per-agent drill-in */}
      {agentDrill && (
        <Card className="p-5">
          <div className="flex items-baseline justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">
                {agentDrill.user?.full_name || agentDrill.user?.email || 'Unknown agent'}
              </h2>
              <p className="text-xs text-gray-500">
                Avg {fmtRating(agentDrill.aggregate.avg_rating)} · {agentDrill.aggregate.total_responded} responded · {fmtPct(agentDrill.aggregate.response_rate)} response rate
              </p>
            </div>
            <Link href="/admin/csat" className="text-xs text-gray-500 hover:underline">
              ← Back to all agents
            </Link>
          </div>
          {agentDrill.surveys.length === 0 ? (
            <p className="text-sm text-gray-500">No surveys for this agent yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {agentDrill.surveys.map((s) => (
                <li key={s.id} className="py-3 flex items-start gap-3">
                  <div className="text-2xl shrink-0">
                    {s.rating ? ratingEmoji(s.rating) : '⏳'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-medium text-sm">
                        {s.rating ? `${s.rating}/5` : 'No response yet'}
                      </span>
                      <span className="text-xs text-gray-400">
                        {s.responded_at
                          ? `responded ${new Date(s.responded_at).toLocaleDateString()}`
                          : `sent ${new Date(s.sent_at).toLocaleDateString()}`}
                      </span>
                      {s.customer_email && (
                        <span className="text-xs text-gray-400">· {s.customer_email}</span>
                      )}
                    </div>
                    {s.feedback && (
                      <p className="text-sm text-gray-700 mt-1 italic">&ldquo;{s.feedback}&rdquo;</p>
                    )}
                    <Link
                      href={`/conversations/${s.conversation_id}`}
                      className="inline-block text-xs text-teal-700 hover:underline mt-1"
                    >
                      View conversation →
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}

// ─── helpers (server-only) ────────────────────────────────────────────────

function Kpi({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wider text-gray-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <div className="text-2xl font-semibold text-gray-900 tabular-nums">{value}</div>
        {suffix && <div className="text-sm text-gray-500">{suffix}</div>}
      </div>
    </Card>
  )
}

function Distribution({ distribution }: { distribution: Record<1 | 2 | 3 | 4 | 5, number> }) {
  const total = (Object.values(distribution) as number[]).reduce((a, b) => a + b, 0)
  const colors: Record<number, string> = {
    1: '#ef4444',
    2: '#f97316',
    3: '#eab308',
    4: '#84cc16',
    5: '#10b981',
  }
  return (
    <div className="space-y-2">
      {[5, 4, 3, 2, 1].map((k) => {
        const v = distribution[k as 1 | 2 | 3 | 4 | 5] || 0
        const pct = total > 0 ? (v / total) * 100 : 0
        return (
          <div key={k} className="flex items-center gap-3 text-sm">
            <span className="w-6 shrink-0 text-right tabular-nums">{k}</span>
            <span className="text-base">{ratingEmoji(k)}</span>
            <div className="flex-1 h-3 bg-gray-100 rounded overflow-hidden">
              <div
                className="h-full rounded"
                style={{ width: `${pct}%`, backgroundColor: colors[k] }}
              />
            </div>
            <span className="w-12 text-right tabular-nums text-xs text-gray-500">
              {v}
            </span>
          </div>
        )
      })}
      {total === 0 && (
        <p className="text-xs text-gray-400 italic">No responses yet.</p>
      )}
    </div>
  )
}

interface WeekBucket {
  start: string
  total: number
  responded: number
  avg: number
}

function bucketWeekly(
  rows: Array<{ rating: number | null; responded_at: string | null; sent_at: string }>,
  start: Date
): WeekBucket[] {
  const buckets: WeekBucket[] = []
  for (let i = 0; i < 12; i++) {
    const ws = new Date(start.getTime() + i * 7 * 24 * 60 * 60 * 1000)
    buckets.push({ start: ws.toISOString(), total: 0, responded: 0, avg: 0 })
  }
  const sums: number[] = new Array(12).fill(0)
  for (const r of rows) {
    const t = new Date(r.sent_at).getTime()
    const idx = Math.floor((t - start.getTime()) / (7 * 24 * 60 * 60 * 1000))
    if (idx < 0 || idx >= 12) continue
    buckets[idx].total += 1
    if (r.responded_at && typeof r.rating === 'number') {
      buckets[idx].responded += 1
      sums[idx] += r.rating
    }
  }
  for (let i = 0; i < 12; i++) {
    buckets[i].avg = buckets[i].responded > 0 ? sums[i] / buckets[i].responded : 0
  }
  return buckets
}

function TrendChart({ weekly }: { weekly: WeekBucket[] }) {
  const w = 600
  const h = 140
  const pad = 24
  const max = Math.max(1, ...weekly.map((b) => b.total))
  const barW = (w - pad * 2) / weekly.length - 4
  return (
    <div className="overflow-x-auto">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-xs">
        {/* X axis */}
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#e5e7eb" />
        {weekly.map((b, i) => {
          const x = pad + i * ((w - pad * 2) / weekly.length) + 2
          const ratio = b.total / max
          const barH = ratio * (h - pad * 2)
          const y = h - pad - barH
          return (
            <g key={i}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                fill="#0d9488"
                opacity={b.responded > 0 ? 1 : 0.4}
                rx={2}
              />
              {b.total > 0 && (
                <text
                  x={x + barW / 2}
                  y={y - 4}
                  textAnchor="middle"
                  fontSize="10"
                  fill="#374151"
                >
                  {b.total}
                </text>
              )}
              <text
                x={x + barW / 2}
                y={h - pad + 12}
                textAnchor="middle"
                fontSize="9"
                fill="#9ca3af"
              >
                W{i + 1}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

async function rollupByAgent(
  admin: Awaited<ReturnType<typeof createServiceRoleClient>>,
  surveys: SurveyJoinRow[],
  dateFrom7: Date
): Promise<AgentRow[]> {
  const byAgent = new Map<string, { sent: number; responded: number; ratingSum: number; r7Sum: number; r7Count: number }>()
  for (const s of surveys) {
    if (!s.agent_user_id) continue
    const cur = byAgent.get(s.agent_user_id) ?? {
      sent: 0,
      responded: 0,
      ratingSum: 0,
      r7Sum: 0,
      r7Count: 0,
    }
    cur.sent += 1
    if (s.responded_at && typeof s.rating === 'number') {
      cur.responded += 1
      cur.ratingSum += s.rating
      if (new Date(s.responded_at).getTime() >= dateFrom7.getTime()) {
        cur.r7Sum += s.rating
        cur.r7Count += 1
      }
    }
    byAgent.set(s.agent_user_id, cur)
  }
  const ids = Array.from(byAgent.keys())
  if (ids.length === 0) return []
  const { data: users } = await admin
    .from('users')
    .select('id, full_name, email')
    .in('id', ids)
  const userMap = new Map<string, UserNameRow>(
    ((users as UserNameRow[]) ?? []).map((u) => [u.id, u])
  )
  return ids
    .map((uid) => {
      const u = userMap.get(uid)
      const v = byAgent.get(uid)!
      return {
        user_id: uid,
        name: u?.full_name || u?.email || 'Unknown',
        email: u?.email || '',
        sent: v.sent,
        responded: v.responded,
        avg: v.responded > 0 ? v.ratingSum / v.responded : 0,
        last7Avg: v.r7Count > 0 ? v.r7Sum / v.r7Count : 0,
      }
    })
    .sort((a, b) => b.avg - a.avg)
}
