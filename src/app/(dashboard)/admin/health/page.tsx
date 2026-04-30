'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { useToast } from '@/components/ui/toast'
import {
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Database,
  KeyRound,
  ShieldAlert,
  Clock,
  Server,
  Plug,
  ExternalLink,
  PlayCircle,
  Inbox,
} from 'lucide-react'

// ─── Shared types ──────────────────────────────────────────────────────

type HealthStatus = 'healthy' | 'warning' | 'error' | 'unknown'

interface EnvCheck {
  name: string
  set: boolean
  hint?: string | null
}

interface EnvReport {
  required: EnvCheck[]
  optional: EnvCheck[]
  encryption_key: {
    set: boolean
    source: 'CHANNEL_CONFIG_ENCRYPTION_KEYS' | 'CHANNEL_CONFIG_ENCRYPTION_KEY' | null
  }
}

interface IntegrationStatus {
  source: 'db' | 'env' | 'none' | 'db_broken'
  last_tested_at: string | null
  last_tested_ok: boolean | null
  client_id_last4: string | null
}

interface OAuthReport {
  integrations: { google_oauth: IntegrationStatus; azure_oauth: IntegrationStatus }
  redirect_uris: { gmail: string; teams: string }
  detected_origin: string
}

interface CronEntry {
  path: string
  schedule: string
  channel: 'email' | 'teams' | null
}

interface ChannelStat {
  max_last_polled_at: string | null
  min_last_polled_at: string | null
  account_count: number
}

interface CronsReport {
  vercel_json_error: string | null
  crons: CronEntry[]
  channel_stats: { email: ChannelStat | null; teams: ChannelStat | null }
  server_time: string
}

interface AccountHealth {
  id: string
  name: string
  channel_type: 'email' | 'teams' | 'whatsapp'
  is_active: boolean
  last_polled_at: string | null
  consecutive_poll_failures: number
  last_poll_error: string | null
  last_poll_error_at: string | null
  has_channel_config: boolean
}

interface DbLatencyReport {
  ok: boolean
  error: string | null
  samples_ms: number[]
  median_ms: number
  min_ms: number
  max_ms: number
  sampled_at: string
}

interface DeploymentProtectionReport {
  probe_url: string
  status: number
  content_type: string
  snippet: string
  blocked: boolean
  fetch_error: string | null
  checked_at: string
}

// ─── Helpers ───────────────────────────────────────────────────────────

function StatusDot({ status }: { status: HealthStatus }) {
  const cls =
    status === 'healthy'
      ? 'bg-green-500'
      : status === 'warning'
      ? 'bg-yellow-500'
      : status === 'error'
      ? 'bg-red-500'
      : 'bg-gray-300'
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} />
}

function StatusIcon({ status }: { status: HealthStatus }) {
  if (status === 'healthy') return <CheckCircle className="h-4 w-4 text-green-500" />
  if (status === 'warning') return <AlertTriangle className="h-4 w-4 text-yellow-500" />
  if (status === 'error') return <XCircle className="h-4 w-4 text-red-500" />
  return <span className="inline-block h-4 w-4 rounded-full bg-gray-200" />
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

/**
 * Polling recency thresholds: every email/teams shard runs every 2 minutes,
 * so anything older than ~10 minutes is suspicious and >30 minutes is stale.
 */
function pollRecencyStatus(iso: string | null): HealthStatus {
  if (!iso) return 'error'
  const ageMs = Date.now() - new Date(iso).getTime()
  if (ageMs < 10 * 60_000) return 'healthy'
  if (ageMs < 30 * 60_000) return 'warning'
  return 'error'
}

// ─── Page ─────────────────────────────────────────────────────────────

export default function HealthPage() {
  const { toast } = useToast()
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const [env, setEnv] = useState<EnvReport | null>(null)
  const [oauth, setOauth] = useState<OAuthReport | null>(null)
  const [crons, setCrons] = useState<CronsReport | null>(null)
  const [accounts, setAccounts] = useState<AccountHealth[] | null>(null)
  const [protection, setProtection] = useState<DeploymentProtectionReport | null>(null)

  const [latency, setLatency] = useState<DbLatencyReport | null>(null)
  const [latencyLoading, setLatencyLoading] = useState(false)

  const [testing, setTesting] = useState<Record<string, boolean>>({})

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    const safeFetch = async <T,>(url: string): Promise<T | null> => {
      try {
        const res = await fetch(url, { cache: 'no-store' })
        if (!res.ok) return null
        return (await res.json()) as T
      } catch {
        return null
      }
    }

    const [envRes, oauthRes, cronsRes, accountsRes, protRes] = await Promise.all([
      safeFetch<EnvReport>('/api/admin/health/env'),
      safeFetch<OAuthReport>('/api/admin/health/oauth'),
      safeFetch<CronsReport>('/api/admin/health/crons'),
      safeFetch<{ accounts: AccountHealth[] }>('/api/admin/health/accounts'),
      safeFetch<DeploymentProtectionReport>('/api/admin/health/deployment-protection'),
    ])

    setEnv(envRes)
    setOauth(oauthRes)
    setCrons(cronsRes)
    setAccounts(accountsRes?.accounts ?? null)
    setProtection(protRes)
    setLastRefresh(new Date())
    setRefreshing(false)
  }, [])

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  const runDbLatency = useCallback(async () => {
    setLatencyLoading(true)
    try {
      const res = await fetch('/api/admin/health/db-latency', { cache: 'no-store' })
      const data = (await res.json()) as DbLatencyReport
      setLatency(data)
    } catch {
      setLatency(null)
      toast.error('Latency probe failed')
    } finally {
      setLatencyLoading(false)
    }
  }, [toast])

  const testIntegration = useCallback(
    async (key: 'google_oauth' | 'azure_oauth') => {
      setTesting((s) => ({ ...s, [key]: true }))
      try {
        const res = await fetch('/api/integrations/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        })
        const data = (await res.json()) as { ok?: boolean; error?: string }
        if (data.ok) toast.success('OAuth credentials verified')
        else toast.error(data.error || 'Test failed')
        // Re-pull oauth status so last_tested_at refreshes.
        const oauthRes = await fetch('/api/admin/health/oauth', { cache: 'no-store' })
        if (oauthRes.ok) setOauth((await oauthRes.json()) as OAuthReport)
      } catch {
        toast.error('Network error testing integration')
      } finally {
        setTesting((s) => ({ ...s, [key]: false }))
      }
    },
    [toast]
  )

  // Aggregate counts for the summary bar
  const totals = (() => {
    let pass = 0
    let warn = 0
    let fail = 0
    if (env) {
      env.required.forEach((c) => (c.set ? pass++ : fail++))
      env.optional.forEach((c) => (c.set ? pass++ : warn++))
      env.encryption_key.set ? pass++ : fail++
    }
    if (oauth) {
      ;(['google_oauth', 'azure_oauth'] as const).forEach((k) => {
        const s = oauth.integrations[k]
        if (s.source === 'none') warn++
        else if (s.source === 'db_broken') fail++
        else if (s.last_tested_ok === false) fail++
        else pass++
      })
    }
    if (crons?.channel_stats) {
      ;(['email', 'teams'] as const).forEach((c) => {
        const stat = crons.channel_stats[c]
        if (!stat || stat.account_count === 0) return
        const s = pollRecencyStatus(stat.max_last_polled_at)
        if (s === 'healthy') pass++
        else if (s === 'warning') warn++
        else fail++
      })
    }
    if (accounts) {
      accounts
        .filter((a) => a.is_active)
        .forEach((a) => {
          if (!a.has_channel_config) fail++
          else if (a.consecutive_poll_failures >= 5) fail++
          else if (a.consecutive_poll_failures > 0) warn++
          else pass++
        })
    }
    if (protection) {
      if (protection.blocked) fail++
      else pass++
    }
    return { pass, warn, fail }
  })()

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">System Health & Setup Wizard</h1>
          <p className="mt-1 text-sm text-gray-500">
            One page to verify env vars, OAuth wiring, cron schedules, polling health, and
            deployment configuration.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">
            Last refreshed: {lastRefresh ? lastRefresh.toLocaleTimeString() : 'Never'}
          </span>
          <Button variant="secondary" onClick={refreshAll} loading={refreshing}>
            <RefreshCw className="h-4 w-4" /> Refresh All
          </Button>
        </div>
      </div>

      {/* G. Deployment Protection banner — top of page so it's the first thing
            you see when something is wrong end-to-end. */}
      {protection?.blocked && (
        <div className="rounded-xl border-2 border-red-300 bg-red-50 p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-red-600" />
            <div className="flex-1">
              <h2 className="text-base font-bold text-red-900">
                Vercel Deployment Protection appears to be ENABLED
              </h2>
              <p className="mt-1 text-sm text-red-800">
                A server-to-server probe of <code className="rounded bg-red-100 px-1 py-0.5 font-mono text-xs">{protection.probe_url}</code>{' '}
                returned <strong>{protection.content_type || 'no content-type'}</strong> (status{' '}
                {protection.status}). Cron jobs, OAuth callbacks, and webhooks all hit the same SSO
                wall — they cannot reach this app while protection is on.
              </p>
              <p className="mt-2 text-sm text-red-800">
                Fix: <strong>Vercel Dashboard → Project → Settings → Deployment Protection → Disable</strong>
                {' '}for this environment, or add an exception for <code className="font-mono">/api/*</code>.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Summary strip */}
      <div className="flex flex-wrap items-center gap-6 rounded-xl border border-gray-200 bg-white px-6 py-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5 text-gray-400" />
          <span className="text-sm font-medium text-gray-700">7 sections</span>
        </div>
        <div className="h-6 w-px bg-gray-200" />
        <div className="flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-green-500" />
          <span className="text-sm text-gray-700">{totals.pass} passing</span>
        </div>
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-yellow-500" />
          <span className="text-sm text-gray-700">{totals.warn} warnings</span>
        </div>
        <div className="flex items-center gap-2">
          <XCircle className="h-4 w-4 text-red-500" />
          <span className="text-sm text-gray-700">{totals.fail} failing</span>
        </div>
      </div>

      {/* A. Environment variables */}
      <Card title="A. Environment variables" description="Server-side presence checks. Values are never sent to the browser.">
        {!env ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Required (red if missing)
              </h4>
              <div className="space-y-1.5">
                {env.required.map((c) => (
                  <EnvRow key={c.name} check={c} requiredVar />
                ))}
                <EnvRow
                  check={{
                    name:
                      env.encryption_key.source ?? 'CHANNEL_CONFIG_ENCRYPTION_KEYS',
                    set: env.encryption_key.set,
                    hint: env.encryption_key.source
                      ? `via ${env.encryption_key.source}`
                      : null,
                  }}
                  requiredVar
                />
              </div>
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Optional (yellow if missing)
              </h4>
              <div className="space-y-1.5">
                {env.optional.map((c) => (
                  <EnvRow key={c.name} check={c} requiredVar={false} />
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* B. OAuth integration status + C. Redirect URI helper */}
      <Card
        title="B + C. OAuth integrations & redirect URIs"
        description="Status of saved OAuth apps and the EXACT callback URLs to register with Google / Microsoft."
      >
        {!oauth ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <IntegrationCard
                provider="Google OAuth (Gmail)"
                status={oauth.integrations.google_oauth}
                onTest={() => testIntegration('google_oauth')}
                testing={!!testing.google_oauth}
              />
              <IntegrationCard
                provider="Azure OAuth (Teams)"
                status={oauth.integrations.azure_oauth}
                onTest={() => testIntegration('azure_oauth')}
                testing={!!testing.azure_oauth}
              />
            </div>

            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-center gap-2">
                <ExternalLink className="h-4 w-4 text-blue-600" />
                <h4 className="text-sm font-semibold text-blue-900">
                  Register these EXACT redirect URIs in your OAuth provider
                </h4>
              </div>
              <p className="mt-1 text-xs text-blue-800">
                Detected origin: <code className="font-mono">{oauth.detected_origin}</code>. If
                that's wrong, fix your <code>NEXT_PUBLIC_SITE_URL</code> or proxy headers — these
                URIs are derived from the request host and must match what the OAuth provider
                expects.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                <CopyField
                  label="Google Cloud → OAuth Client → Authorized redirect URIs"
                  value={oauth.redirect_uris.gmail}
                />
                <CopyField
                  label="Azure App Registration → Web → Redirect URIs"
                  value={oauth.redirect_uris.teams}
                />
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* D. Cron schedules */}
      <Card
        title="D. Cron schedules"
        description="From vercel.json. Email + Teams entries also show how recently any account in that channel was polled."
      >
        {!crons ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : crons.vercel_json_error ? (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            Failed to read vercel.json: {crons.vercel_json_error}
          </div>
        ) : (
          <div className="space-y-3">
            {(['email', 'teams'] as const).map((channel) => {
              const stat = crons.channel_stats[channel]
              if (!stat) return null
              const status = pollRecencyStatus(stat.max_last_polled_at)
              return (
                <div
                  key={channel}
                  className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    <StatusDot status={status} />
                    <div>
                      <div className="text-sm font-medium capitalize text-gray-800">
                        {channel} polling
                      </div>
                      <div className="text-xs text-gray-500">
                        {stat.account_count} active account{stat.account_count === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>
                  <div className="text-right text-xs text-gray-600">
                    <div>Most recent poll: {relativeTime(stat.max_last_polled_at)}</div>
                    {stat.account_count > 1 && stat.min_last_polled_at && (
                      <div>Oldest stranded: {relativeTime(stat.min_last_polled_at)}</div>
                    )}
                  </div>
                </div>
              )
            })}
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Path</th>
                    <th className="px-3 py-2 font-semibold">Schedule (UTC)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {crons.crons.map((c, i) => (
                    <tr key={`${c.path}-${i}`} className="text-gray-700">
                      <td className="px-3 py-1.5 font-mono text-xs">{c.path}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{c.schedule}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      {/* E. Per-account channel health */}
      <Card
        title="E. Per-account channel health"
        description="Last poll, consecutive failure counter, last error, and whether a channel_configs row exists."
      >
        {!accounts ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : accounts.length === 0 ? (
          <div className="text-sm text-gray-500">No accounts configured.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Account</th>
                  <th className="px-3 py-2 font-semibold">Channel</th>
                  <th className="px-3 py-2 font-semibold">Config saved</th>
                  <th className="px-3 py-2 font-semibold">Last polled</th>
                  <th className="px-3 py-2 font-semibold">Failures</th>
                  <th className="px-3 py-2 font-semibold">Last error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {accounts.map((a) => {
                  const failuresStatus: HealthStatus =
                    a.consecutive_poll_failures >= 5
                      ? 'error'
                      : a.consecutive_poll_failures > 0
                      ? 'warning'
                      : 'healthy'
                  return (
                    <tr key={a.id} className={a.is_active ? '' : 'opacity-50'}>
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-900">{a.name}</div>
                        {!a.is_active && (
                          <div className="text-xs text-gray-500">inactive</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          variant={
                            a.channel_type === 'teams'
                              ? 'teams'
                              : a.channel_type === 'whatsapp'
                              ? 'whatsapp'
                              : 'email'
                          }
                        >
                          {a.channel_type}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        {a.has_channel_config ? (
                          <span className="inline-flex items-center gap-1 text-green-700">
                            <CheckCircle className="h-3.5 w-3.5" /> yes
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-red-700">
                            <XCircle className="h-3.5 w-3.5" /> missing
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <StatusDot status={pollRecencyStatus(a.last_polled_at)} />
                          <span className="text-xs text-gray-600">
                            {relativeTime(a.last_polled_at)}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <StatusDot status={failuresStatus} />
                          <span className="text-xs text-gray-700">
                            {a.consecutive_poll_failures}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        <span title={a.last_poll_error ?? ''} className="block max-w-[280px] truncate">
                          {a.last_poll_error ?? '—'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* F. DB latency */}
      <Card
        title="F. Database latency"
        description="On-demand round-trip probe to Supabase. Useful for catching region mismatches."
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Database className="h-5 w-5 text-emerald-600" />
            {latency ? (
              <div>
                <div className="text-sm font-medium text-gray-900">
                  Median {latency.median_ms} ms{' '}
                  <span className="text-xs font-normal text-gray-500">
                    (min {latency.min_ms}, max {latency.max_ms}, n=3)
                  </span>
                </div>
                <div className="text-xs text-gray-500">
                  Sampled {relativeTime(latency.sampled_at)}{' '}
                  {latency.error && (
                    <span className="text-red-600"> — {latency.error}</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-500">Click "Run probe" to measure.</div>
            )}
          </div>
          <Button variant="secondary" onClick={runDbLatency} loading={latencyLoading}>
            <PlayCircle className="h-4 w-4" /> Run probe
          </Button>
        </div>
      </Card>

      {/* G. Deployment Protection — detail card (banner above is for the WORST case). */}
      <Card
        title="G. Vercel Deployment Protection probe"
        description="Server-to-server hits /api/test-connection without auth and checks if the response is JSON or an SSO HTML wall."
      >
        {!protection ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (
          <div className="flex items-start gap-3">
            {protection.blocked ? (
              <XCircle className="h-5 w-5 text-red-500" />
            ) : protection.fetch_error ? (
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
            ) : (
              <CheckCircle className="h-5 w-5 text-green-500" />
            )}
            <div className="flex-1 text-sm text-gray-700">
              <div>
                Probe URL:{' '}
                <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs">
                  {protection.probe_url}
                </code>
              </div>
              <div className="mt-1">
                Status <strong>{protection.status || '—'}</strong> · Content-Type{' '}
                <strong>{protection.content_type || '—'}</strong>
              </div>
              {protection.fetch_error && (
                <div className="mt-1 text-yellow-700">Fetch error: {protection.fetch_error}</div>
              )}
              {protection.snippet && (
                <pre className="mt-2 max-h-24 overflow-auto rounded bg-gray-50 p-2 text-[11px] text-gray-600">
                  {protection.snippet}
                </pre>
              )}
              {!protection.blocked && !protection.fetch_error && (
                <div className="mt-1 text-xs text-green-700">
                  No SSO wall detected — external services (cron, OAuth, webhooks) can reach this
                  app.
                </div>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

// ─── Subcomponents ─────────────────────────────────────────────────────

function EnvRow({ check, requiredVar }: { check: EnvCheck; requiredVar: boolean }) {
  const status: HealthStatus = check.set ? 'healthy' : requiredVar ? 'error' : 'warning'
  return (
    <div className="flex items-center justify-between rounded border border-gray-100 px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon status={status} />
        <code className="truncate font-mono text-xs text-gray-800">{check.name}</code>
      </div>
      <div className="ml-3 shrink-0 text-xs text-gray-500">
        {check.set ? check.hint ?? 'set' : requiredVar ? 'MISSING' : 'not set'}
      </div>
    </div>
  )
}

function IntegrationCard({
  provider,
  status,
  onTest,
  testing,
}: {
  provider: string
  status: IntegrationStatus
  onTest: () => void
  testing: boolean
}) {
  const sourceBadge =
    status.source === 'db' ? (
      <Badge variant="success">db</Badge>
    ) : status.source === 'env' ? (
      <Badge variant="info">env</Badge>
    ) : status.source === 'db_broken' ? (
      <Badge variant="danger">db_broken</Badge>
    ) : (
      <Badge variant="warning">none</Badge>
    )

  const testStatusBadge =
    status.last_tested_ok === true ? (
      <Badge variant="success">tested ok</Badge>
    ) : status.last_tested_ok === false ? (
      <Badge variant="danger">test failed</Badge>
    ) : null

  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-gray-500" />
          <h4 className="font-semibold text-gray-900">{provider}</h4>
        </div>
        {sourceBadge}
      </div>
      <div className="mt-3 space-y-1 text-xs text-gray-600">
        <div className="flex items-center gap-2">
          <KeyRound className="h-3.5 w-3.5 text-gray-400" />
          client_id ending: {status.client_id_last4 ? `…${status.client_id_last4}` : '—'}
        </div>
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-gray-400" />
          last tested: {relativeTime(status.last_tested_at)} {testStatusBadge}
        </div>
        {status.source === 'db_broken' && (
          <div className="flex items-center gap-2 text-red-700">
            <AlertTriangle className="h-3.5 w-3.5" />
            Stored credentials cannot be decrypted — encryption key likely rotated. Re-save the
            credentials at <code>/admin/integrations</code>.
          </div>
        )}
        {status.source === 'none' && (
          <div className="flex items-center gap-2 text-yellow-700">
            <Inbox className="h-3.5 w-3.5" />
            Not configured anywhere. Configure at <code>/admin/integrations</code>.
          </div>
        )}
      </div>
      <div className="mt-3">
        <Button
          size="sm"
          variant="secondary"
          onClick={onTest}
          loading={testing}
          disabled={status.source === 'none'}
        >
          Test now
        </Button>
      </div>
    </div>
  )
}
