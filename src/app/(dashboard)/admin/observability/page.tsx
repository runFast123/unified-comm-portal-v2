/**
 * /admin/observability — operational SLI dashboard.
 *
 * Server component, server-rendered on every request (force-dynamic). Pulls
 * data directly from Supabase with the service-role client so we don't have
 * to maintain dedicated API routes for every roll-up. Admin-only; non-admins
 * are redirected to /dashboard.
 *
 * Layout:
 *   1. Top SLI strip — last 60 minutes: cron success rate, p50/p95 cron
 *      duration per cron name, messages ingested, AI calls + cost, AI error
 *      rate, webhook 5xx rate.
 *   2. Charts — simple inline SVG bar charts (no chart library dependency):
 *        - Cron runs per minute over last 6h, color-coded by success.
 *        - AI cost per hour over last 24h.
 *        - Messages ingested per hour over last 24h.
 *   3. Tables — top 10 errors in last 24h, per-account AI spend rank today.
 */

import { redirect } from 'next/navigation'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { Card } from '@/components/ui/card'

export const dynamic = 'force-dynamic'

// ─── Types ─────────────────────────────────────────────────────────────

interface MetricRow {
  metric_name: string
  value: number
  ts: string
  labels: Record<string, unknown> | null
}

interface AiUsageRow {
  account_id: string
  estimated_cost_usd: number | string | null
  created_at: string
}

interface AuditRow {
  action: string
  details: unknown
  created_at: string
}

interface CronStat {
  name: string
  total: number
  ok: number
  err: number
  p50: number
  p95: number
}

// ─── Helpers ───────────────────────────────────────────────────────────

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  }
  return sorted[base]
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(1)}%`
}

/**
 * Bin a list of timestamped events into N evenly-sized buckets covering
 * `[now - rangeMs, now]`. Each bin is `(start, end, accumulator)`. The
 * `pick` callback supplies the per-event value to add into its bucket.
 */
function bin<T extends { ts: string | Date }>(
  events: T[],
  rangeMs: number,
  bins: number,
  pick: (e: T) => number
): { startMs: number; values: number[] } {
  const now = Date.now()
  const startMs = now - rangeMs
  const slot = rangeMs / bins
  const out = new Array<number>(bins).fill(0)
  for (const e of events) {
    const t = typeof e.ts === 'string' ? Date.parse(e.ts) : e.ts.getTime()
    if (!Number.isFinite(t) || t < startMs) continue
    const idx = Math.min(bins - 1, Math.floor((t - startMs) / slot))
    out[idx] += pick(e)
  }
  return { startMs, values: out }
}

// ─── Auth gate ─────────────────────────────────────────────────────────

async function requireAdminUser(): Promise<void> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  if (!['admin','super_admin','company_admin'].includes(profile?.role ?? '')) redirect('/dashboard')
}

// ─── Data load ─────────────────────────────────────────────────────────

interface DashboardData {
  metricsLastHour: MetricRow[]
  metricsLast6h: MetricRow[]
  metricsLast24h: MetricRow[]
  aiUsage24h: AiUsageRow[]
  errorsLast24h: AuditRow[]
  webhook5xxLastHour: number
  webhookTotalLastHour: number
}

async function loadDashboardData(): Promise<DashboardData> {
  const admin = await createServiceRoleClient()
  const now = Date.now()
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()
  const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000).toISOString()
  const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString()

  // Run independent queries in parallel — total wall-clock dominates the page
  // load otherwise. Each is wrapped via `safe()` to swallow query errors so
  // a missing table (e.g. metrics_events on a fresh deploy) or RLS hiccup
  // renders empty rather than 500-ing the page.
  async function safe<T>(p: PromiseLike<{ data: T[] | null }>): Promise<T[]> {
    try {
      const res = await p
      return res.data ?? []
    } catch {
      return []
    }
  }

  const [
    metricsLastHourRes,
    metricsLast6hRes,
    metricsLast24hRes,
    aiUsageRes,
    errorsRes,
  ] = await Promise.all([
    safe<MetricRow>(
      admin
        .from('metrics_events')
        .select('metric_name, value, ts, labels')
        .gte('ts', oneHourAgo)
        .order('ts', { ascending: false })
        .limit(10000)
    ),
    safe<MetricRow>(
      admin
        .from('metrics_events')
        .select('metric_name, value, ts, labels')
        .gte('ts', sixHoursAgo)
        .like('metric_name', 'cron.%')
        .order('ts', { ascending: false })
        .limit(20000)
    ),
    safe<MetricRow>(
      admin
        .from('metrics_events')
        .select('metric_name, value, ts, labels')
        .gte('ts', twentyFourHoursAgo)
        .order('ts', { ascending: false })
        .limit(20000)
    ),
    safe<AiUsageRow>(
      admin
        .from('ai_usage')
        // ai_usage's timestamp column is `ts` (NOT created_at) — alias it so
        // the downstream r.created_at usage keeps working. The previous query
        // selected/filtered a non-existent column, so this panel was empty.
        .select('account_id, estimated_cost_usd, created_at:ts')
        .gte('ts', twentyFourHoursAgo)
        .order('ts', { ascending: false })
        .limit(20000)
    ),
    safe<AuditRow>(
      admin
        .from('audit_log')
        .select('action, details, created_at')
        .gte('created_at', twentyFourHoursAgo)
        .or('action.ilike.%error%,action.ilike.%failed%')
        .order('created_at', { ascending: false })
        .limit(2000)
    ),
  ])

  const metricsLastHour = metricsLastHourRes
  // Webhook 5xx ratio is approximated from cron error counters within the
  // last hour. For a v1 we don't have route-level HTTP counters yet; this
  // is the closest available proxy and lines up with what operators care
  // about ("are webhooks crashing?").
  const cronLastHour = metricsLastHour.filter((m) => m.metric_name.startsWith('cron.') && m.metric_name.endsWith('.duration_ms'))
  const webhookTotalLastHour = cronLastHour.length
  const webhook5xxLastHour = cronLastHour.filter((m) => (m.labels as { success?: boolean })?.success === false).length

  return {
    metricsLastHour,
    metricsLast6h: metricsLast6hRes,
    metricsLast24h: metricsLast24hRes,
    aiUsage24h: aiUsageRes,
    errorsLast24h: errorsRes,
    webhook5xxLastHour,
    webhookTotalLastHour,
  }
}

// ─── Computations ──────────────────────────────────────────────────────

function computeCronStats(rows: MetricRow[]): CronStat[] {
  // Group `cron.X.duration_ms` rows by the cron name.
  const byCron = new Map<string, { durations: number[]; ok: number; err: number }>()
  for (const r of rows) {
    if (!r.metric_name.startsWith('cron.') || !r.metric_name.endsWith('.duration_ms')) continue
    const name = r.metric_name.replace(/^cron\./, '').replace(/\.duration_ms$/, '')
    const bucket = byCron.get(name) ?? { durations: [], ok: 0, err: 0 }
    bucket.durations.push(Number(r.value))
    const success = (r.labels as { success?: boolean })?.success
    if (success === false) bucket.err++
    else bucket.ok++
    byCron.set(name, bucket)
  }
  const out: CronStat[] = []
  for (const [name, b] of byCron.entries()) {
    const sorted = [...b.durations].sort((a, b) => a - b)
    out.push({
      name,
      total: b.ok + b.err,
      ok: b.ok,
      err: b.err,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

interface BarChartProps {
  values: number[]
  startMs: number
  rangeMs: number
  height?: number
  successByBin?: boolean[]
  fmt?: (v: number) => string
  yLabel?: string
}

/**
 * Tiny bar chart — pure SVG, no library. Fixed-width 100% with a configurable
 * height; bars share a single shared scale derived from the max value.
 *
 * `successByBin`, when supplied, paints bars red where a bin contains any
 * unsuccessful events. Otherwise everything's green.
 */
function BarChart({
  values,
  startMs,
  rangeMs,
  height = 80,
  successByBin,
  fmt = (v) => v.toFixed(0),
  yLabel,
}: BarChartProps) {
  const max = Math.max(1, ...values)
  const n = values.length
  const barW = 100 / n
  const endMs = startMs + rangeMs

  return (
    <div className="space-y-1">
      {yLabel && (
        <div className="flex items-center justify-between text-[10px] text-gray-500">
          <span>peak {fmt(max)}</span>
          <span>{yLabel}</span>
        </div>
      )}
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="block w-full overflow-visible"
        style={{ height: `${height}px` }}
        role="img"
        aria-label={yLabel ?? 'metric chart'}
      >
        {values.map((v, i) => {
          const h = (v / max) * (height - 2)
          const y = height - h
          const x = i * barW
          const failed = successByBin?.[i] === false
          const fill = v === 0 ? '#e5e7eb' : failed ? '#ef4444' : '#10b981'
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={Math.max(0.5, barW - 0.3)}
              height={Math.max(0.5, h)}
              fill={fill}
            >
              <title>{`${new Date(startMs + i * (rangeMs / n)).toLocaleString()}: ${fmt(v)}`}</title>
            </rect>
          )
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-gray-500">
        <span>{new Date(startMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <span>{new Date(endMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </div>
  )
}

// ─── KPI tile ──────────────────────────────────────────────────────────

function Kpi({
  label,
  value,
  sub,
  status,
}: {
  label: string
  value: string
  sub?: string
  status?: 'good' | 'warn' | 'bad' | 'neutral'
}) {
  const ring =
    status === 'good'
      ? 'ring-emerald-200 bg-emerald-50'
      : status === 'warn'
      ? 'ring-yellow-200 bg-yellow-50'
      : status === 'bad'
      ? 'ring-red-200 bg-red-50'
      : 'ring-gray-200 bg-white'
  const valueColor =
    status === 'good'
      ? 'text-emerald-700'
      : status === 'warn'
      ? 'text-yellow-700'
      : status === 'bad'
      ? 'text-red-700'
      : 'text-gray-900'
  return (
    <div className={`rounded-lg p-4 ring-1 ${ring}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${valueColor}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────

export default async function ObservabilityPage() {
  await requireAdminUser()
  const data = await loadDashboardData()

  // ── Top-row SLIs (last hour) ────────────────────────────────────────
  const cronStats = computeCronStats(data.metricsLastHour)
  const cronTotal = cronStats.reduce((s, c) => s + c.total, 0)
  const cronOk = cronStats.reduce((s, c) => s + c.ok, 0)
  const cronSuccessRate = cronTotal > 0 ? (cronOk / cronTotal) * 100 : 100

  const messagesIngestedLastHour = data.metricsLastHour
    .filter((m) => m.metric_name === 'webhook.email.ingested')
    .reduce((s, r) => s + Number(r.value), 0)

  const aiCallsLastHour = data.metricsLastHour.filter((m) => m.metric_name === 'ai.call_duration_ms')
  const aiCallsCount = aiCallsLastHour.length
  const aiErrorsCount = aiCallsLastHour.filter(
    (m) => (m.labels as { success?: boolean })?.success === false
  ).length
  const aiErrorRate = aiCallsCount > 0 ? (aiErrorsCount / aiCallsCount) * 100 : 0

  const oneHourAgoMs = Date.now() - 60 * 60 * 1000
  const aiSpendLastHour = data.aiUsage24h
    .filter((r) => Date.parse(r.created_at) >= oneHourAgoMs)
    .reduce((s, r) => s + Number(r.estimated_cost_usd ?? 0), 0)
  const aiSpendToday = data.aiUsage24h.reduce((s, r) => s + Number(r.estimated_cost_usd ?? 0), 0)

  const webhook5xxRate =
    data.webhookTotalLastHour > 0
      ? (data.webhook5xxLastHour / data.webhookTotalLastHour) * 100
      : 0

  // ── Charts ──────────────────────────────────────────────────────────
  const cronEventsLast6h = data.metricsLast6h.filter((m) => m.metric_name.endsWith('.duration_ms'))
  const cron6hBin = bin(
    cronEventsLast6h.map((m) => ({ ts: m.ts, success: (m.labels as { success?: boolean })?.success !== false })),
    6 * 60 * 60 * 1000,
    72, // 6h / 5min
    () => 1
  )
  // success-by-bin: true if all events in bin succeeded
  const cron6hSuccess = new Array<boolean>(72).fill(true)
  for (const ev of cronEventsLast6h) {
    const t = Date.parse(ev.ts)
    if (!Number.isFinite(t)) continue
    const offset = t - cron6hBin.startMs
    if (offset < 0) continue
    const idx = Math.min(71, Math.floor(offset / (5 * 60 * 1000)))
    if ((ev.labels as { success?: boolean })?.success === false) cron6hSuccess[idx] = false
  }

  const aiCost24hBin = bin(
    data.aiUsage24h.map((r) => ({ ts: r.created_at, cost: Number(r.estimated_cost_usd ?? 0) })),
    24 * 60 * 60 * 1000,
    24,
    (e) => e.cost
  )

  const ingestEvents24h = data.metricsLast24h.filter((m) => m.metric_name === 'webhook.email.ingested')
  const ingest24hBin = bin(
    ingestEvents24h.map((m) => ({ ts: m.ts, count: Number(m.value) })),
    24 * 60 * 60 * 1000,
    24,
    (e) => e.count
  )

  // ── Top errors (group by action) ────────────────────────────────────
  const errorByAction = new Map<string, number>()
  for (const r of data.errorsLast24h) {
    errorByAction.set(r.action, (errorByAction.get(r.action) ?? 0) + 1)
  }
  const topErrors = [...errorByAction.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  // ── Per-account AI spend (today) ────────────────────────────────────
  const startOfTodayMs = (() => {
    const d = new Date()
    d.setUTCHours(0, 0, 0, 0)
    return d.getTime()
  })()
  const spendByAccount = new Map<string, number>()
  for (const r of data.aiUsage24h) {
    if (Date.parse(r.created_at) < startOfTodayMs) continue
    const prev = spendByAccount.get(r.account_id) ?? 0
    spendByAccount.set(r.account_id, prev + Number(r.estimated_cost_usd ?? 0))
  }
  const topSpendAccountIds = [...spendByAccount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)

  // Resolve account names for the top-spend table.
  const accountNames = new Map<string, string>()
  if (topSpendAccountIds.length > 0) {
    try {
      const adminClient = await createServiceRoleClient()
      const { data: rows } = await adminClient
        .from('accounts')
        .select('id, name')
        .in(
          'id',
          topSpendAccountIds.map(([id]) => id)
        )
      for (const r of rows ?? []) accountNames.set(r.id as string, r.name as string)
    } catch {
      // Fall through — we'll show the bare account_id if the lookup fails.
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Observability</h1>
        <p className="mt-1 text-sm text-gray-500">
          Operational SLIs from the{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">metrics_events</code> stream.
          Last hour KPIs at the top; rolling charts and tables below. All times UTC server-time.
        </p>
      </div>

      {/* Top-row SLIs — grouped into three logical sections so operators can
          scan by domain (system / cost / reliability) instead of squinting at
          a single 6-tile strip of mixed metrics. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            System Health
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Kpi
              label="Cron success (1h)"
              value={fmtPct(cronSuccessRate)}
              sub={`${cronOk}/${cronTotal} runs`}
              status={cronSuccessRate >= 99 ? 'good' : cronSuccessRate >= 95 ? 'warn' : 'bad'}
            />
            <Kpi
              label="AI error rate (1h)"
              value={fmtPct(aiErrorRate)}
              sub={`${aiErrorsCount}/${aiCallsCount} errors`}
              status={aiErrorRate <= 1 ? 'good' : aiErrorRate <= 5 ? 'warn' : 'bad'}
            />
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            AI Cost
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Kpi
              label="AI calls (1h)"
              value={aiCallsCount.toLocaleString()}
              sub={`spend ${fmtUsd(aiSpendLastHour)}`}
              status="neutral"
            />
            <Kpi
              label="AI spend (today)"
              value={fmtUsd(aiSpendToday)}
              sub={`${data.aiUsage24h.length} calls in 24h`}
              status="neutral"
            />
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Reliability
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Kpi
              label="Webhook 5xx rate (1h)"
              value={fmtPct(webhook5xxRate)}
              sub={`${data.webhook5xxLastHour}/${data.webhookTotalLastHour} cron runs`}
              status={webhook5xxRate <= 1 ? 'good' : webhook5xxRate <= 5 ? 'warn' : 'bad'}
            />
            <Kpi
              label="Messages ingested (1h)"
              value={messagesIngestedLastHour.toLocaleString()}
              sub="from email + teams crons"
              status="neutral"
            />
          </div>
        </section>
      </div>

      {/* Per-cron p50 / p95 */}
      <Card
        title="Cron duration percentiles (last hour)"
        description="Per cron name. Each cron route emits a duration metric on completion; p50 and p95 are computed across the last hour."
      >
        {cronStats.length === 0 ? (
          <div className="text-sm text-gray-500">
            No cron runs in the last hour. Once <code className="font-mono">recordMetric</code>{' '}
            calls fire from the cron routes, percentiles will appear here.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Cron</th>
                  <th className="px-3 py-2 font-semibold">Runs</th>
                  <th className="px-3 py-2 font-semibold">Errors</th>
                  <th className="px-3 py-2 font-semibold">p50</th>
                  <th className="px-3 py-2 font-semibold">p95</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {cronStats.map((c) => (
                  <tr key={c.name}>
                    <td className="px-3 py-2 font-mono text-xs text-gray-800">{c.name}</td>
                    <td className="px-3 py-2 text-gray-700">{c.total}</td>
                    <td className={`px-3 py-2 ${c.err > 0 ? 'text-red-700' : 'text-gray-500'}`}>{c.err}</td>
                    <td className="px-3 py-2 text-gray-700">{fmtMs(c.p50)}</td>
                    <td className="px-3 py-2 text-gray-700">{fmtMs(c.p95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card
          title="Cron runs (last 6h)"
          description="Per 5-minute bin. Red bars indicate at least one failed run."
        >
          <BarChart
            values={cron6hBin.values}
            startMs={cron6hBin.startMs}
            rangeMs={6 * 60 * 60 * 1000}
            successByBin={cron6hSuccess}
            yLabel="runs / 5 min"
          />
        </Card>
        <Card
          title="AI cost (last 24h)"
          description="Per-hour USD spend, summed across all accounts and endpoints."
        >
          <BarChart
            values={aiCost24hBin.values}
            startMs={aiCost24hBin.startMs}
            rangeMs={24 * 60 * 60 * 1000}
            fmt={(v) => fmtUsd(v)}
            yLabel="USD / hour"
          />
        </Card>
        <Card
          title="Messages ingested (last 24h)"
          description="Per-hour count from webhook.email.ingested events."
        >
          <BarChart
            values={ingest24hBin.values}
            startMs={ingest24hBin.startMs}
            rangeMs={24 * 60 * 60 * 1000}
            yLabel="messages / hour"
          />
        </Card>
      </div>

      {/* Tables */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card
          title="Top errors (last 24h)"
          description="audit_log rows where action ILIKE '%error%' OR '%failed%', grouped by action."
        >
          {topErrors.length === 0 ? (
            <div className="text-sm text-gray-500">No error actions logged in the last 24 hours.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Action</th>
                  <th className="px-3 py-2 font-semibold">Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {topErrors.map(([action, count]) => (
                  <tr key={action}>
                    <td className="px-3 py-2 font-mono text-xs text-gray-800">{action}</td>
                    <td className="px-3 py-2 text-gray-700">{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card
          title="Per-account AI spend (today, UTC)"
          description="Sum of estimated_cost_usd from ai_usage since 00:00 UTC."
        >
          {topSpendAccountIds.length === 0 ? (
            <div className="text-sm text-gray-500">No AI usage recorded yet today.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Account</th>
                  <th className="px-3 py-2 font-semibold">Spend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {topSpendAccountIds.map(([id, cost]) => (
                  <tr key={id}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900">
                        {accountNames.get(id) ?? <span className="font-mono text-xs">{id.slice(0, 8)}…</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-gray-700">{fmtUsd(cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  )
}
