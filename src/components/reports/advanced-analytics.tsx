'use client'

import { useState, useEffect } from 'react'
import { ReportCard } from '@/components/reports/report-card'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase-client'
import { cn, timeAgo } from '@/lib/utils'
import {
  Shield,
  ShieldAlert,
  Users,
  MessageCircle,
  AlertTriangle,
  CheckCircle,
  Clock,
  TrendingUp,
  Mail,
  Loader2,
} from 'lucide-react'

// ─── Shared Types ────────────────────────────────────────────────────────────

interface ConvHealth {
  active: number
  in_progress: number
  waiting_on_customer: number
  resolved: number
  escalated: number
  archived: number
}

interface SpamBreakdown {
  reason: string
  count: number
}

interface AiFunnel {
  pending_approval: number
  approved: number
  sent: number
  rejected: number
  edited: number
  auto_sent: number
}

interface AgentLoad {
  name: string
  conversations: number
  pending: number
}

interface EscalatedConv {
  id: string
  participant_name: string | null
  channel: string
  account_name: string
  last_message_at: string | null
  priority: string
}

// ─── Donut Chart ──────────────────────────────────────────────────────────────

function DonutChart({ segments, size = 120 }: { segments: { label: string; value: number; color: string }[]; size?: number }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0)
  if (total === 0) return <p className="text-sm text-gray-400 text-center py-4">No data</p>
  const radius = size / 2 - 8
  const circumference = 2 * Math.PI * radius
  let offset = 0

  return (
    <div className="flex items-center gap-6">
      <svg width={size} height={size} className="shrink-0">
        <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke="#f3f4f6" strokeWidth={14} />
        {segments.map((seg, i) => {
          const pct = seg.value / total
          const dash = circumference * pct
          const gap = circumference - dash
          const rot = offset * 360 - 90
          offset += pct
          return (
            <circle
              key={i}
              cx={size/2} cy={size/2} r={radius}
              fill="none" stroke={seg.color} strokeWidth={14}
              strokeDasharray={`${dash} ${gap}`}
              transform={`rotate(${rot} ${size/2} ${size/2})`}
              className="transition-all duration-500"
            />
          )
        })}
        <text x={size/2} y={size/2} textAnchor="middle" dominantBaseline="central" className="fill-gray-900 text-xl font-bold">{total}</text>
      </svg>
      <div className="space-y-1.5">
        {segments.filter(s => s.value > 0).map((seg, i) => (
          <div key={i} className="flex items-center gap-2 text-sm">
            <span className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
            <span className="text-gray-600">{seg.label}</span>
            <span className="font-semibold text-gray-900 ml-auto">{seg.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Funnel Chart ─────────────────────────────────────────────────────────────

function FunnelChart({ data }: { data: AiFunnel }) {
  const steps = [
    { label: 'Generated', value: data.pending_approval + data.approved + data.sent + data.rejected + data.edited + data.auto_sent, color: 'bg-blue-500' },
    { label: 'Pending Review', value: data.pending_approval, color: 'bg-amber-500' },
    { label: 'Approved', value: data.approved + data.sent + data.auto_sent, color: 'bg-teal-500' },
    { label: 'Sent', value: data.sent + data.auto_sent, color: 'bg-green-500' },
    { label: 'Rejected', value: data.rejected, color: 'bg-red-400' },
    { label: 'Edited', value: data.edited, color: 'bg-purple-400' },
  ]
  const maxVal = Math.max(...steps.map(s => s.value), 1)

  return (
    <div className="space-y-2">
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="text-xs text-gray-500 w-28 text-right shrink-0">{step.label}</span>
          <div className="flex-1 h-7 bg-gray-100 rounded-lg overflow-hidden relative">
            <div
              className={cn('h-full rounded-lg transition-all duration-500', step.color)}
              style={{ width: `${Math.max((step.value / maxVal) * 100, 2)}%` }}
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-semibold text-gray-700">{step.value}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Horizontal Bar ───────────────────────────────────────────────────────────

function HorizontalBars({ items, colorFn }: { items: { label: string; value: number }[]; colorFn?: (label: string) => string }) {
  const maxVal = Math.max(...items.map(i => i.value), 1)
  const defaultColors: Record<string, string> = {
    newsletter: 'bg-amber-400', marketing: 'bg-orange-400', automated_notification: 'bg-blue-400',
    spam: 'bg-red-400', ai_classified_newsletter: 'bg-purple-400',
    low: 'bg-gray-400', medium: 'bg-amber-400', high: 'bg-orange-500', urgent: 'bg-red-500',
    active: 'bg-green-500', resolved: 'bg-teal-500', escalated: 'bg-red-500',
    in_progress: 'bg-blue-500', waiting_on_customer: 'bg-amber-500', archived: 'bg-gray-400',
  }
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="text-xs text-gray-600 w-36 text-right shrink-0 truncate capitalize">{item.label.replace(/_/g, ' ')}</span>
          <div className="flex-1 h-6 bg-gray-100 rounded overflow-hidden relative">
            <div
              className={cn('h-full rounded transition-all', colorFn ? colorFn(item.label) : (defaultColors[item.label] || 'bg-teal-500'))}
              style={{ width: `${Math.max((item.value / maxVal) * 100, 3)}%` }}
            />
          </div>
          <span className="text-xs font-semibold text-gray-700 w-10 text-right">{item.value}</span>
        </div>
      ))}
      {items.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No data</p>}
    </div>
  )
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, subtitle, icon: Icon, color }: { label: string; value: string | number; subtitle?: string; icon: React.ElementType; color: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg shrink-0', color)}>
          <Icon className="h-5 w-5 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-gray-500 truncate">{label}</p>
          <p className="text-xl font-bold text-gray-900 leading-tight">{value}</p>
          {subtitle && <p className="text-[10px] text-gray-400 truncate">{subtitle}</p>}
        </div>
        <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', color)}>
          <Icon className="h-4 w-4 text-white" />
        </div>
      </div>
    </div>
  )
}

// ─── Overview Enhancements ────────────────────────────────────────────────────

export function OverviewEnhancements({ dateStart }: { dateStart: string }) {
  const [convHealth, setConvHealth] = useState<ConvHealth>({ active: 0, in_progress: 0, waiting_on_customer: 0, resolved: 0, escalated: 0, archived: 0 })
  const [spamBreakdown, setSpamBreakdown] = useState<SpamBreakdown[]>([])
  const [totalSpam, setTotalSpam] = useState(0)
  const [totalReal, setTotalReal] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      setLoading(true)
      const supabase = createClient()

      // Conversation health
      const { data: convs } = await supabase.from('conversations').select('status')
      const health: ConvHealth = { active: 0, in_progress: 0, waiting_on_customer: 0, resolved: 0, escalated: 0, archived: 0 }
      ;(convs || []).forEach((c: any) => { if (c.status in health) (health as any)[c.status]++ })
      setConvHealth(health)

      // Spam breakdown
      const { data: spamMsgs } = await supabase
        .from('messages')
        .select('spam_reason')
        .eq('is_spam', true)
        .eq('direction', 'inbound')
        .gte('received_at', dateStart)
      const reasons: Record<string, number> = {}
      ;(spamMsgs || []).forEach((m: any) => {
        const r = m.spam_reason || 'unknown'
        reasons[r] = (reasons[r] || 0) + 1
      })
      setSpamBreakdown(Object.entries(reasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count))
      setTotalSpam(spamMsgs?.length || 0)

      // Total real messages
      const { count } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('is_spam', false)
        .eq('direction', 'inbound')
        .gte('received_at', dateStart)
      setTotalReal(count || 0)

      setLoading(false)
    }
    fetch()
  }, [dateStart])

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <ReportCard title="Conversation Health" description="Current status of all conversations">
        <DonutChart segments={[
          { label: 'Active', value: convHealth.active, color: '#22c55e' },
          { label: 'In Progress', value: convHealth.in_progress, color: '#3b82f6' },
          { label: 'Waiting on Customer', value: convHealth.waiting_on_customer, color: '#f59e0b' },
          { label: 'Resolved', value: convHealth.resolved, color: '#14b8a6' },
          { label: 'Escalated', value: convHealth.escalated, color: '#ef4444' },
          { label: 'Archived', value: convHealth.archived, color: '#9ca3af' },
        ]} />
      </ReportCard>

      <ReportCard title="Spam Detection" description={`${totalSpam} spam vs ${totalReal} real messages this period`}>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Spam Caught" value={totalSpam} icon={ShieldAlert} color="bg-red-500" />
            <StatCard label="Real Messages" value={totalReal} icon={CheckCircle} color="bg-green-500" />
            <StatCard label="Catch Rate" value={totalReal + totalSpam > 0 ? `${Math.round((totalSpam / (totalReal + totalSpam)) * 100)}%` : '0%'} icon={Shield} color="bg-teal-600" />
          </div>
          <HorizontalBars items={spamBreakdown.map(s => ({ label: s.reason, value: s.count }))} />
        </div>
      </ReportCard>
    </div>
  )
}

// ─── AI Performance Enhancements ──────────────────────────────────────────────

export function AIPerformanceEnhancements({ dateStart }: { dateStart: string }) {
  const [funnel, setFunnel] = useState<AiFunnel>({ pending_approval: 0, approved: 0, sent: 0, rejected: 0, edited: 0, auto_sent: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      setLoading(true)
      const supabase = createClient()
      const { data } = await supabase
        .from('ai_replies')
        .select('status')
        .gte('created_at', dateStart)

      const f: AiFunnel = { pending_approval: 0, approved: 0, sent: 0, rejected: 0, edited: 0, auto_sent: 0 }
      ;(data || []).forEach((r: any) => { if (r.status in f) (f as any)[r.status]++ })
      setFunnel(f)
      setLoading(false)
    }
    fetch()
  }, [dateStart])

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>

  return (
    <ReportCard title="AI Reply Outcome Funnel" description="How AI-generated drafts progress through the review pipeline">
      <FunnelChart data={funnel} />
    </ReportCard>
  )
}

// ─── Trends Enhancements ──────────────────────────────────────────────────────

export function TrendsEnhancements() {
  const [spamTrend, setSpamTrend] = useState<{ date: string; spam: number; real: number }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      setLoading(true)
      const supabase = createClient()
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

      const { data: msgs } = await supabase
        .from('messages')
        .select('received_at, is_spam')
        .eq('direction', 'inbound')
        .gte('received_at', thirtyDaysAgo)

      const byDay: Record<string, { spam: number; real: number }> = {}
      ;(msgs || []).forEach((m: any) => {
        const day = m.received_at?.substring(0, 10)
        if (!day) return
        if (!byDay[day]) byDay[day] = { spam: 0, real: 0 }
        if (m.is_spam) byDay[day].spam++
        else byDay[day].real++
      })

      const days: string[] = []
      for (let i = 29; i >= 0; i--) {
        days.push(new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().substring(0, 10))
      }
      setSpamTrend(days.map(d => ({ date: d, spam: byDay[d]?.spam || 0, real: byDay[d]?.real || 0 })))
      setLoading(false)
    }
    fetch()
  }, [])

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>

  return (
    <ReportCard title="Spam vs Real Customer Messages (30 Days)" description="Daily breakdown of filtered spam vs legitimate messages">
      <div className="space-y-1">
        <div className="flex items-end gap-0.5" style={{ height: 140 }}>
          {spamTrend.map((d, i) => {
            const total = d.spam + d.real
            const maxTotal = Math.max(...spamTrend.map(x => x.spam + x.real), 1)
            const pct = Math.max((total / maxTotal) * 100, 2)
            const spamPct = total > 0 ? (d.spam / total) * 100 : 0
            return (
              <div key={i} className="flex-1 flex flex-col group relative" style={{ height: `${pct}%` }}>
                <div className="absolute -top-8 left-1/2 -translate-x-1/2 hidden group-hover:block bg-gray-800 text-white text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap z-10">
                  {d.real} real, {d.spam} spam
                </div>
                <div className="bg-red-400 rounded-t" style={{ height: `${spamPct}%`, minHeight: d.spam > 0 ? 2 : 0 }} />
                <div className="bg-teal-500 flex-1 rounded-b" />
              </div>
            )
          })}
        </div>
        <div className="flex justify-between text-[10px] text-gray-400 px-0.5">
          <span>{spamTrend[0]?.date?.slice(5)}</span>
          <span>{spamTrend[14]?.date?.slice(5)}</span>
          <span>{spamTrend[29]?.date?.slice(5)}</span>
        </div>
        <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-teal-500" /> Real</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-red-400" /> Spam</span>
        </div>
      </div>
    </ReportCard>
  )
}

// ─── Conversations Tab ────────────────────────────────────────────────────────

export function ConversationsTab() {
  const [convHealth, setConvHealth] = useState<ConvHealth>({ active: 0, in_progress: 0, waiting_on_customer: 0, resolved: 0, escalated: 0, archived: 0 })
  const [priorityDist, setPriorityDist] = useState<{ label: string; value: number }[]>([])
  const [escalated, setEscalated] = useState<EscalatedConv[]>([])
  const [agents, setAgents] = useState<AgentLoad[]>([])
  const [avgResolution, setAvgResolution] = useState<{ email: string; teams: string }>({ email: '--', teams: '--' })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      setLoading(true)
      const supabase = createClient()

      // Status breakdown
      const { data: convs } = await supabase.from('conversations').select('status, priority, channel, assigned_to, first_message_at, last_message_at')
      const health: ConvHealth = { active: 0, in_progress: 0, waiting_on_customer: 0, resolved: 0, escalated: 0, archived: 0 }
      const prio: Record<string, number> = { low: 0, medium: 0, high: 0, urgent: 0 }
      const resTimes: Record<string, number[]> = { email: [], teams: [] }

      ;(convs || []).forEach((c: any) => {
        if (c.status in health) (health as any)[c.status]++
        if (c.priority in prio) prio[c.priority]++
        if (c.status === 'resolved' && c.first_message_at && c.last_message_at) {
          const mins = (new Date(c.last_message_at).getTime() - new Date(c.first_message_at).getTime()) / 60000
          if (mins > 0 && mins < 10080 && c.channel in resTimes) resTimes[c.channel].push(mins)
        }
      })
      setConvHealth(health)
      setPriorityDist(Object.entries(prio).map(([label, value]) => ({ label, value })))

      const avgEmail = resTimes.email.length > 0 ? Math.round(resTimes.email.reduce((s, v) => s + v, 0) / resTimes.email.length) : 0
      const avgTeams = resTimes.teams.length > 0 ? Math.round(resTimes.teams.reduce((s, v) => s + v, 0) / resTimes.teams.length) : 0
      setAvgResolution({
        email: avgEmail > 0 ? (avgEmail >= 60 ? `${Math.floor(avgEmail / 60)}h ${avgEmail % 60}m` : `${avgEmail}m`) : '--',
        teams: avgTeams > 0 ? (avgTeams >= 60 ? `${Math.floor(avgTeams / 60)}h ${avgTeams % 60}m` : `${avgTeams}m`) : '--',
      })

      // Escalated conversations
      const { data: escConvs } = await supabase
        .from('conversations')
        .select('id, participant_name, channel, priority, last_message_at, accounts!conversations_account_id_fkey(name)')
        .eq('status', 'escalated')
        .order('last_message_at', { ascending: false })
        .limit(10)
      setEscalated((escConvs || []).map((c: any) => ({
        id: c.id,
        participant_name: c.participant_name,
        channel: c.channel,
        account_name: c.accounts?.name || 'Unknown',
        last_message_at: c.last_message_at,
        priority: c.priority,
      })))

      // Agent workload
      const { data: assignedConvs } = await supabase
        .from('conversations')
        .select('assigned_to, status, users!conversations_assigned_to_fkey(full_name)')
        .not('assigned_to', 'is', null)
      const agentMap: Record<string, { name: string; total: number; pending: number }> = {}
      ;(assignedConvs || []).forEach((c: any) => {
        const uid = c.assigned_to
        if (!uid) return
        if (!agentMap[uid]) agentMap[uid] = { name: c.users?.full_name || 'Unknown', total: 0, pending: 0 }
        agentMap[uid].total++
        if (c.status === 'active' || c.status === 'escalated') agentMap[uid].pending++
      })
      setAgents(Object.values(agentMap).map(a => ({ name: a.name, conversations: a.total, pending: a.pending })).sort((a, b) => b.conversations - a.conversations))

      setLoading(false)
    }
    fetch()
  }, [])

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>

  return (
    <div className="space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: 'Active', value: convHealth.active, color: 'bg-green-500', icon: MessageCircle },
          { label: 'In Progress', value: convHealth.in_progress, color: 'bg-blue-500', icon: Clock },
          { label: 'Waiting', value: convHealth.waiting_on_customer, color: 'bg-amber-500', icon: Clock },
          { label: 'Resolved', value: convHealth.resolved, color: 'bg-teal-500', icon: CheckCircle },
          { label: 'Escalated', value: convHealth.escalated, color: 'bg-red-500', icon: AlertTriangle },
          { label: 'Archived', value: convHealth.archived, color: 'bg-gray-500', icon: Shield },
        ].map((s, i) => (
          <StatCard key={i} label={s.label} value={s.value} icon={s.icon} color={s.color} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Priority Distribution */}
        <ReportCard title="Priority Distribution" description="Conversation priorities across all channels">
          <HorizontalBars items={priorityDist} />
        </ReportCard>

        {/* Avg Resolution Time */}
        <ReportCard title="Avg Resolution Time by Channel" description="Time from first message to resolved">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-gray-200 p-4 text-center">
              <Mail className="h-6 w-6 mx-auto text-red-500 mb-2" />
              <p className="text-2xl font-bold text-gray-900">{avgResolution.email}</p>
              <p className="text-xs text-gray-500 mt-1">Email</p>
            </div>
            <div className="rounded-xl border border-gray-200 p-4 text-center">
              <MessageCircle className="h-6 w-6 mx-auto text-indigo-500 mb-2" />
              <p className="text-2xl font-bold text-gray-900">{avgResolution.teams}</p>
              <p className="text-xs text-gray-500 mt-1">Teams</p>
            </div>
          </div>
        </ReportCard>
      </div>

      {/* Escalated Conversations */}
      {escalated.length > 0 && (
        <ReportCard title={`Escalated Conversations (${escalated.length})`} description="Conversations requiring urgent attention">
          <div className="divide-y divide-gray-100">
            {escalated.map(c => (
              <a key={c.id} href={`/conversations/${c.id}`} className="flex items-center gap-3 py-2.5 hover:bg-gray-50 px-2 -mx-2 rounded transition-colors">
                <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', c.priority === 'urgent' ? 'bg-red-500' : 'bg-orange-400')} />
                <span className="text-sm font-medium text-gray-800 flex-1 truncate">{c.participant_name || 'Unknown'}</span>
                <span className="text-xs text-gray-500">{c.account_name.replace(/\s+Teams$/i, '')}</span>
                <Badge variant={c.channel === 'teams' ? 'info' : 'default'} size="sm">{c.channel}</Badge>
                <span className="text-xs text-gray-400">{c.last_message_at ? timeAgo(c.last_message_at) : '--'}</span>
              </a>
            ))}
          </div>
        </ReportCard>
      )}

      {/* Agent Workload */}
      {agents.length > 0 && (
        <ReportCard title="Agent Workload" description="Conversations assigned per agent">
          <div className="divide-y divide-gray-100">
            <div className="grid grid-cols-3 py-2 text-xs font-semibold text-gray-500 uppercase">
              <span>Agent</span>
              <span className="text-center">Total Assigned</span>
              <span className="text-center">Active/Escalated</span>
            </div>
            {agents.map((a, i) => (
              <div key={i} className="grid grid-cols-3 py-2.5 text-sm">
                <span className="font-medium text-gray-800 flex items-center gap-2">
                  <Users className="h-4 w-4 text-gray-400" />
                  {a.name}
                </span>
                <span className="text-center text-gray-600">{a.conversations}</span>
                <span className="text-center">
                  {a.pending > 0 ? (
                    <span className="inline-flex items-center gap-1 text-orange-600 font-semibold">{a.pending}</span>
                  ) : (
                    <span className="text-gray-400">0</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </ReportCard>
      )}
    </div>
  )
}

// ─── Spam & Filters Tab ───────────────────────────────────────────────────────

export function SpamFiltersTab({ dateStart }: { dateStart: string }) {
  const [spamByReason, setSpamByReason] = useState<{ label: string; value: number }[]>([])
  const [spamByAccount, setSpamByAccount] = useState<{ label: string; value: number }[]>([])
  const [totalSpam, setTotalSpam] = useState(0)
  const [ruleBasedCount, setRuleBasedCount] = useState(0)
  const [aiDetectedCount, setAiDetectedCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      setLoading(true)
      const supabase = createClient()

      // Spam by reason
      const { data: spamMsgs } = await supabase
        .from('messages')
        .select('spam_reason, account_id, accounts!messages_account_id_fkey(name)')
        .eq('is_spam', true)
        .eq('direction', 'inbound')
        .gte('received_at', dateStart)

      const reasons: Record<string, number> = {}
      const accounts: Record<string, number> = {}
      let ruleBased = 0
      let aiDetected = 0

      ;(spamMsgs || []).forEach((m: any) => {
        const r = m.spam_reason || 'unknown'
        reasons[r] = (reasons[r] || 0) + 1
        const accName = m.accounts?.name?.replace(/\s+Teams$/i, '') || 'Unknown'
        accounts[accName] = (accounts[accName] || 0) + 1
        if (r === 'ai_classified_newsletter') aiDetected++
        else ruleBased++
      })

      setSpamByReason(Object.entries(reasons).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value))
      setSpamByAccount(Object.entries(accounts).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value))
      setTotalSpam(spamMsgs?.length || 0)
      setRuleBasedCount(ruleBased)
      setAiDetectedCount(aiDetected)
      setLoading(false)
    }
    fetch()
  }, [dateStart])

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total Spam Filtered" value={totalSpam} icon={ShieldAlert} color="bg-red-500" />
        <StatCard label="Rule-Based Catches" value={ruleBasedCount} subtitle="Sender/subject/body patterns" icon={Shield} color="bg-amber-500" />
        <StatCard label="AI Detected" value={aiDetectedCount} subtitle="Newsletter/Marketing by AI" icon={TrendingUp} color="bg-purple-500" />
        <StatCard label="Detection Split" value={totalSpam > 0 ? `${Math.round((ruleBasedCount / totalSpam) * 100)}% rules` : '--'} subtitle={totalSpam > 0 ? `${Math.round((aiDetectedCount / totalSpam) * 100)}% AI` : ''} icon={CheckCircle} color="bg-teal-600" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ReportCard title="Spam by Reason" description="What triggered the spam filter">
          <HorizontalBars items={spamByReason} />
        </ReportCard>

        <ReportCard title="Spam by Account" description="Which accounts receive the most spam">
          <HorizontalBars items={spamByAccount} colorFn={() => 'bg-red-400'} />
        </ReportCard>
      </div>
    </div>
  )
}
