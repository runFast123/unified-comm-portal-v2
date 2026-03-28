'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  MessageCircle,
  Clock,
  Bot,
  Timer,
  Smile,
  Tag,

  TrendingUp,
  Mail,
  MessageSquare,
  Phone,
  Filter,
  X,
  ChevronDown,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { KPICard } from '@/components/dashboard/kpi-card'
import { ChannelFilter, type ChannelFilterValue } from '@/components/dashboard/channel-filter'
import { AccountsTable } from '@/components/dashboard/accounts-table'
import { ActivityFeed } from '@/components/dashboard/activity-feed'
import { createClient } from '@/lib/supabase-client'
import { formatResponseTime, getChannelLabel, getChannelBgColor } from '@/lib/utils'
import type { DashboardKPIs } from '@/types/database'
import type { AccountOverview } from '@/types/database'
import type { ChannelType } from '@/types/database'
import { useUser } from '@/context/user-context'

const ACCOUNT_FILTER_KEY = 'dashboard-account-filter'

function loadAccountFilter(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const stored = localStorage.getItem(ACCOUNT_FILTER_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as string[]
      if (Array.isArray(parsed) && parsed.length > 0) return new Set(parsed)
    }
  } catch {}
  return new Set()
}

function saveAccountFilter(ids: Set<string>) {
  if (typeof window === 'undefined') return
  if (ids.size === 0) {
    localStorage.removeItem(ACCOUNT_FILTER_KEY)
  } else {
    localStorage.setItem(ACCOUNT_FILTER_KEY, JSON.stringify([...ids]))
  }
}

interface ChannelStats {
  channel: ChannelType
  messageCount: number
  pendingCount: number
  aiSentCount: number
}

interface CategoryBreakdown {
  category: string
  count: number
}

type DateRange = 'today' | '7days' | '30days'

const defaultKPIs: DashboardKPIs = {
  totalMessagesToday: 0,
  pendingReplies: 0,
  aiRepliesSent: 0,
  avgResponseTime: 0,
  sentimentScore: { positive: 0, neutral: 100, negative: 0 },
  topCategory: { name: 'N/A', count: 0 },
}

const defaultChannelStats: ChannelStats[] = [
  { channel: 'teams', messageCount: 0, pendingCount: 0, aiSentCount: 0 },
  { channel: 'email', messageCount: 0, pendingCount: 0, aiSentCount: 0 },
  { channel: 'whatsapp', messageCount: 0, pendingCount: 0, aiSentCount: 0 },
]

function getDateRangeStart(range: DateRange): string {
  const now = new Date()
  switch (range) {
    case 'today': {
      const start = new Date(now)
      start.setHours(0, 0, 0, 0)
      return start.toISOString()
    }
    case '7days': {
      const start = new Date(now)
      start.setDate(start.getDate() - 7)
      start.setHours(0, 0, 0, 0)
      return start.toISOString()
    }
    case '30days': {
      const start = new Date(now)
      start.setDate(start.getDate() - 30)
      start.setHours(0, 0, 0, 0)
      return start.toISOString()
    }
  }
}

function getDateRangeLabel(range: DateRange): string {
  switch (range) {
    case 'today': return 'today'
    case '7days': return 'last 7 days'
    case '30days': return 'last 30 days'
  }
}

function getChannelColoredIcon(channel: ChannelType) {
  switch (channel) {
    case 'email':
      return <Mail className="h-5 w-5 text-red-500" />
    case 'teams':
      return <MessageSquare className="h-5 w-5 text-purple-500" />
    case 'whatsapp':
      return <Phone className="h-5 w-5 text-green-500" />
  }
}

export default function DashboardPage() {
  const router = useRouter()
  const { isAdmin, account_id: userAccountId } = useUser()
  const [channelFilter, setChannelFilter] = useState<ChannelFilterValue>('all')
  const [dateRange, setDateRange] = useState<DateRange>('today')
  const [loading, setLoading] = useState(true)
  const [kpis, setKpis] = useState<DashboardKPIs>(defaultKPIs)
  const [channelStats, setChannelStats] = useState<ChannelStats[]>(defaultChannelStats)
  const [categories, setCategories] = useState<CategoryBreakdown[]>([])
  const [accounts, setAccounts] = useState<AccountOverview[]>([])
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set())
  const [accountFilterOpen, setAccountFilterOpen] = useState(false)
  const [slaStats, setSlaStats] = useState<{ avgResponseMins: number; compliancePct: number; breachedCount: number }>({
    avgResponseMins: 0,
    compliancePct: 100,
    breachedCount: 0,
  })
  const [spamFilteredToday, setSpamFilteredToday] = useState(0)

  // Load account filter from localStorage after mount (avoids hydration mismatch)
  useEffect(() => {
    const stored = loadAccountFilter()
    if (stored.size > 0) setSelectedAccountIds(stored)
  }, [])

  const handleToggleAccount = useCallback((accountId: string) => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev)
      if (next.has(accountId)) {
        next.delete(accountId)
      } else {
        next.add(accountId)
      }
      saveAccountFilter(next)
      return next
    })
  }, [])

  const handleClearAccountFilter = useCallback(() => {
    setSelectedAccountIds(new Set())
    saveAccountFilter(new Set())
  }, [])

  const handleSelectAllAccounts = useCallback(() => {
    const allIds = new Set(accounts.map((a) => a.id))
    setSelectedAccountIds(allIds)
    saveAccountFilter(allIds)
  }, [accounts])

  // Filter accounts by selected IDs (empty = show all)
  const isAccountFiltered = selectedAccountIds.size > 0
  const filteredAccounts = useMemo(() => {
    if (!isAccountFiltered) return accounts
    return accounts.filter((a) => selectedAccountIds.has(a.id))
  }, [accounts, selectedAccountIds, isAccountFiltered])

  // Compute filtered KPIs based on selected accounts
  const filteredKpis = useMemo((): DashboardKPIs => {
    if (!isAccountFiltered) return kpis
    // Sum pending counts from filtered accounts
    const totalPending = filteredAccounts.reduce((sum, a) => sum + a.pendingCount, 0)
    return {
      ...kpis,
      pendingReplies: totalPending,
    }
  }, [kpis, filteredAccounts, isAccountFiltered])

  const filteredChannelStats = useMemo((): ChannelStats[] => {
    if (!isAccountFiltered) return channelStats
    // When account filter is active, filter channel stats to only show channels matching filtered accounts
    const activeChannels = new Set(filteredAccounts.map((a) => a.channel_type))
    return channelStats.filter((s) => activeChannels.has(s.channel))
  }, [channelStats, filteredAccounts, isAccountFiltered])

  useEffect(() => {
    async function fetchDashboardData() {
      setLoading(true)
      const supabase = createClient()
      const rangeISO = getDateRangeStart(dateRange)

      try {
        // Build scoped queries - non-admins only see their company's data
        const accountIdFilter = !isAdmin && userAccountId ? userAccountId : null

        let accountsQuery = supabase
          .from('accounts')
          .select('id, name, channel_type, phase1_enabled, phase2_enabled')
          .eq('is_active', true)
          .order('name')
        if (accountIdFilter) accountsQuery = accountsQuery.eq('id', accountIdFilter)

        let channelMsgQuery = supabase
          .from('messages')
          .select('channel')
          .gte('received_at', rangeISO)
          .eq('direction', 'inbound')
        if (accountIdFilter) channelMsgQuery = channelMsgQuery.eq('account_id', accountIdFilter)

        let channelPendingQuery = supabase
          .from('messages')
          .select('channel')
          .gte('received_at', rangeISO)
          .eq('direction', 'inbound')
          .eq('reply_required', true)
          .eq('replied', false)
        if (accountIdFilter) channelPendingQuery = channelPendingQuery.eq('account_id', accountIdFilter)

        let aiSentQuery = supabase
          .from('ai_replies')
          .select('channel')
          .gte('sent_at', rangeISO)
          .eq('status', 'sent')
        if (accountIdFilter) aiSentQuery = aiSentQuery.eq('account_id', accountIdFilter)

        // Combine category + sentiment into a single query (same table, same date filter)
        let classificationQuery = supabase
          .from('message_classifications')
          .select('category, sentiment')
          .gte('classified_at', rangeISO)

        // Account pending counts (for account overview table)
        let pendingByAccountQuery = supabase
          .from('messages')
          .select('account_id')
          .eq('direction', 'inbound')
          .eq('reply_required', true)
          .eq('replied', false)
        if (accountIdFilter) pendingByAccountQuery = pendingByAccountQuery.eq('account_id', accountIdFilter)

        // Last message time per account
        let lastMsgQuery = supabase
          .from('messages')
          .select('account_id, received_at')
          .eq('direction', 'inbound')
          .order('received_at', { ascending: false })
        if (accountIdFilter) lastMsgQuery = lastMsgQuery.eq('account_id', accountIdFilter)

        // SLA: inbound messages in range
        let slaInboundQuery = supabase
          .from('messages')
          .select('id, conversation_id, received_at')
          .eq('direction', 'inbound')
          .gte('received_at', rangeISO)
        if (accountIdFilter) slaInboundQuery = slaInboundQuery.eq('account_id', accountIdFilter)

        // SLA: outbound replies in range
        let slaOutboundQuery = supabase
          .from('messages')
          .select('conversation_id, timestamp')
          .eq('direction', 'outbound')
          .gte('timestamp', rangeISO)
          .order('timestamp', { ascending: true })
        if (accountIdFilter) slaOutboundQuery = slaOutboundQuery.eq('account_id', accountIdFilter)

        // Fetch ALL data in a single Promise.all (no sequential awaits)
        const [
          kpiResult,
          accountsResult,
          channelMessagesResult,
          channelPendingResult,
          channelAiSentResult,
          classificationResult,
          pendingByAccountResult,
          lastMsgResult,
          slaInboundResult,
          slaOutboundResult,
        ] = await Promise.all([
          supabase.rpc('get_dashboard_kpis'),
          accountsQuery,
          channelMsgQuery,
          channelPendingQuery,
          aiSentQuery,
          classificationQuery,
          pendingByAccountQuery,
          lastMsgQuery,
          slaInboundQuery,
          slaOutboundQuery,
        ])

        // --- Process KPIs ---
        let processedKpis = { ...defaultKPIs }
        if (kpiResult.data && !kpiResult.error) {
          const d = kpiResult.data
          processedKpis.totalMessagesToday = d.total_messages_today ?? 0
          processedKpis.pendingReplies = d.pending_replies ?? 0
          processedKpis.aiRepliesSent = d.ai_replies_sent_today ?? 0
          processedKpis.avgResponseTime = d.avg_response_time_mins ?? 0
        }

        // Override with date-range-filtered counts when not "today"
        if (dateRange !== 'today') {
          const totalInRange = (channelMessagesResult.data ?? []).length
          const pendingInRange = (channelPendingResult.data ?? []).length
          const aiSentInRange = (channelAiSentResult.data ?? []).length
          processedKpis.totalMessagesToday = totalInRange
          processedKpis.pendingReplies = pendingInRange
          processedKpis.aiRepliesSent = aiSentInRange
        }

        // --- Process sentiment + category from combined query ---
        const classificationData = classificationResult.data ?? []
        if (classificationData.length > 0) {
          const total = classificationData.length
          const pos = classificationData.filter((r: { sentiment: string }) => r.sentiment === 'positive').length
          const neg = classificationData.filter((r: { sentiment: string }) => r.sentiment === 'negative').length
          const neu = total - pos - neg
          processedKpis.sentimentScore = {
            positive: Math.round((pos / total) * 100),
            neutral: Math.round((neu / total) * 100),
            negative: Math.round((neg / total) * 100),
          }
        }

        // --- Process category breakdown from same combined query ---
        let processedCategories: CategoryBreakdown[] = []
        if (classificationData.length > 0) {
          const catCounts: Record<string, number> = {}
          for (const row of classificationData) {
            const cat = (row as { category: string }).category
            catCounts[cat] = (catCounts[cat] || 0) + 1
          }
          processedCategories = Object.entries(catCounts)
            .map(([category, count]) => ({ category, count }))
            .sort((a, b) => b.count - a.count)

          if (processedCategories.length > 0) {
            processedKpis.topCategory = {
              name: processedCategories[0].category,
              count: processedCategories[0].count,
            }
          }
        }

        // --- Process channel stats ---
        const channels: ChannelType[] = ['teams', 'email', 'whatsapp']
        const processedChannelStats: ChannelStats[] = channels.map((ch) => {
          const messageCount = (channelMessagesResult.data ?? [])
            .filter((r: { channel: string }) => r.channel === ch).length
          const pendingCount = (channelPendingResult.data ?? [])
            .filter((r: { channel: string }) => r.channel === ch).length
          const aiSentCount = (channelAiSentResult.data ?? [])
            .filter((r: { channel: string }) => r.channel === ch).length
          return { channel: ch, messageCount, pendingCount, aiSentCount }
        })

        // --- Process accounts (data already fetched in parallel) ---
        let processedAccounts: AccountOverview[] = []
        if (accountsResult.data) {
          const pendingByAccount: Record<string, number> = {}
          if (pendingByAccountResult.data) {
            for (const row of pendingByAccountResult.data) {
              const aid = (row as { account_id: string }).account_id
              pendingByAccount[aid] = (pendingByAccount[aid] || 0) + 1
            }
          }

          const lastMsgByAccount: Record<string, string> = {}
          if (lastMsgResult.data) {
            for (const row of lastMsgResult.data) {
              const r = row as { account_id: string; received_at: string }
              if (!lastMsgByAccount[r.account_id]) {
                lastMsgByAccount[r.account_id] = r.received_at
              }
            }
          }

          processedAccounts = accountsResult.data.map((acct: {
            id: string
            name: string
            channel_type: ChannelType
            phase1_enabled: boolean
            phase2_enabled: boolean
          }) => ({
            id: acct.id,
            name: acct.name,
            channel_type: acct.channel_type,
            phase1_enabled: acct.phase1_enabled,
            phase2_enabled: acct.phase2_enabled,
            pendingCount: pendingByAccount[acct.id] || 0,
            lastMessageTime: lastMsgByAccount[acct.id] || '',
          }))
        }

        // --- SLA Stats (data already fetched in parallel) ---
        try {
          const slaInbound = slaInboundResult.data
          const slaOutbound = slaOutboundResult.data
          const DEFAULT_SLA_CRITICAL_HOURS = 4

          if (slaInbound && slaInbound.length > 0) {
            const firstReplyByConv: Record<string, string> = {}
            if (slaOutbound) {
              for (const row of slaOutbound) {
                const r = row as { conversation_id: string; timestamp: string }
                if (!firstReplyByConv[r.conversation_id]) {
                  firstReplyByConv[r.conversation_id] = r.timestamp
                }
              }
            }

            let totalResponseMs = 0
            let respondedCount = 0
            let withinSLA = 0
            let breached = 0
            const now = Date.now()

            for (const msg of slaInbound as { id: string; conversation_id: string; received_at: string }[]) {
              const receivedMs = new Date(msg.received_at).getTime()
              const replyTs = firstReplyByConv[msg.conversation_id]

              if (replyTs) {
                const replyMs = new Date(replyTs).getTime()
                const responseMs = replyMs - receivedMs
                if (responseMs > 0) {
                  totalResponseMs += responseMs
                  respondedCount++
                  if (responseMs <= DEFAULT_SLA_CRITICAL_HOURS * 60 * 60 * 1000) {
                    withinSLA++
                  } else {
                    breached++
                  }
                }
              } else {
                const waitMs = now - receivedMs
                if (waitMs > DEFAULT_SLA_CRITICAL_HOURS * 60 * 60 * 1000) {
                  breached++
                }
              }
            }

            const avgResponseMins = respondedCount > 0 ? Math.round(totalResponseMs / respondedCount / 60000) : 0
            const compliancePct = respondedCount > 0 ? Math.round((withinSLA / respondedCount) * 100) : 100

            setSlaStats({ avgResponseMins, compliancePct, breachedCount: breached })
          } else {
            setSlaStats({ avgResponseMins: 0, compliancePct: 100, breachedCount: 0 })
          }
        } catch (slaErr) {
          console.error('Failed to compute SLA stats:', slaErr)
        }

        // --- Spam Stats ---
        try {
          let spamQuery = supabase
            .from('messages')
            .select('id', { count: 'exact', head: true })
            .eq('direction', 'inbound')
            .eq('is_spam', true)
            .gte('received_at', rangeISO)
          if (accountIdFilter) spamQuery = spamQuery.eq('account_id', accountIdFilter)
          const { count: spamTotal } = await spamQuery
          setSpamFilteredToday(spamTotal ?? 0)
        } catch (spamErr) {
          console.error('Failed to fetch spam stats:', spamErr)
        }

        setKpis(processedKpis)
        setChannelStats(processedChannelStats)
        setCategories(processedCategories)
        setAccounts(processedAccounts)
      } catch (err) {
        console.error('Failed to fetch dashboard data:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchDashboardData()
  }, [dateRange, isAdmin, userAccountId])

  const maxCategoryCount = categories[0]?.count ?? 1

  if (loading) {
    return (
      <div className="space-y-6 animate-fade-in">
        {/* Header skeleton */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
            <div className="mt-1 h-4 w-48 rounded bg-gray-200 animate-pulse" />
          </div>
          <div className="h-9 w-64 rounded-lg bg-gray-200 animate-pulse" />
        </div>

        {/* Date range skeleton */}
        <div className="flex items-center gap-2">
          <div className="h-8 w-20 rounded-lg bg-gray-200 animate-pulse" />
          <div className="h-8 w-20 rounded-lg bg-gray-200 animate-pulse" />
          <div className="h-8 w-20 rounded-lg bg-gray-200 animate-pulse" />
        </div>

        {/* KPI skeleton cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between">
                <div className="flex-1 space-y-3">
                  <div className="h-4 w-24 rounded bg-gray-200 animate-pulse" />
                  <div className="h-8 w-16 rounded bg-gray-200 animate-pulse" />
                  <div className="h-3 w-20 rounded bg-gray-200 animate-pulse" />
                </div>
                <div className="h-10 w-10 rounded-lg bg-gray-200 animate-pulse" />
              </div>
            </div>
          ))}
        </div>

        {/* SLA skeleton */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between">
                <div className="flex-1 space-y-3">
                  <div className="h-4 w-28 rounded bg-gray-200 animate-pulse" />
                  <div className="h-8 w-16 rounded bg-gray-200 animate-pulse" />
                  <div className="h-3 w-32 rounded bg-gray-200 animate-pulse" />
                </div>
                <div className="h-10 w-10 rounded-lg bg-gray-200 animate-pulse" />
              </div>
            </div>
          ))}
        </div>

        {/* Bottom cards skeleton */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="h-5 w-32 rounded bg-gray-200 animate-pulse mb-4" />
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, j) => (
                  <div key={j} className="h-6 w-full rounded bg-gray-100 animate-pulse" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Page header with channel filter */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            {isAccountFiltered
              ? `Filtered view: ${filteredAccounts.length} of ${accounts.length} accounts`
              : `Unified overview across all ${accounts.length} accounts`}
          </p>
        </div>
        <ChannelFilter
          activeChannel={channelFilter}
          onChange={setChannelFilter}
        />
      </div>

      {/* Date Range Selector + Account Filter */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-500 mr-1">Period:</span>
          {([
            { key: 'today' as DateRange, label: 'Today' },
            { key: '7days' as DateRange, label: '7 Days' },
            { key: '30days' as DateRange, label: '30 Days' },
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setDateRange(key)}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                dateRange === key
                  ? 'bg-teal-600 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Account Filter Dropdown - only for admins */}
        {isAdmin && <div className="relative">
          <button
            onClick={() => setAccountFilterOpen((v) => !v)}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              isAccountFiltered
                ? 'border-teal-300 bg-teal-50 text-teal-700'
                : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            <Filter className="h-4 w-4" />
            {isAccountFiltered
              ? `${selectedAccountIds.size} account${selectedAccountIds.size > 1 ? 's' : ''}`
              : 'Filter Accounts'}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${accountFilterOpen ? 'rotate-180' : ''}`} />
          </button>

          {isAccountFiltered && (
            <button
              onClick={handleClearAccountFilter}
              className="ml-1 inline-flex items-center rounded-full p-1 text-teal-600 hover:bg-teal-100 transition-colors"
              title="Clear account filter"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}

          {accountFilterOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => setAccountFilterOpen(false)}
              />
              <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg">
                <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Filter by Account
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSelectAllAccounts}
                      className="text-xs text-teal-600 hover:text-teal-800 font-medium"
                    >
                      Select All
                    </button>
                    <span className="text-gray-300">|</span>
                    <button
                      onClick={handleClearAccountFilter}
                      className="text-xs text-gray-500 hover:text-gray-700 font-medium"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto py-1">
                  {accounts.length === 0 ? (
                    <p className="px-3 py-4 text-center text-sm text-gray-400">No accounts found</p>
                  ) : (
                    accounts.map((account) => (
                      <label
                        key={account.id}
                        className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={selectedAccountIds.has(account.id)}
                          onChange={() => handleToggleAccount(account.id)}
                          className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                        />
                        <ChannelIcon channel={account.channel_type} size={16} />
                        <span className="flex-1 text-sm text-gray-700 truncate">
                          {account.name}
                        </span>
                        {account.pendingCount > 0 && (
                          <span className="text-xs text-orange-600 font-medium">
                            {account.pendingCount} pending
                          </span>
                        )}
                      </label>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>}
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 [&>div]:min-w-0">
        <div onClick={() => router.push('/inbox')} className="cursor-pointer relative rounded-xl border border-gray-200 bg-gradient-to-br from-blue-50 to-blue-100 p-5 shadow-sm transition-shadow hover:shadow-lg">
          <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-blue-600" />
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-500">Total Messages</p>
              <p className="mt-1 text-3xl font-bold text-gray-900">{filteredKpis.totalMessagesToday}</p>
              <div className="mt-2 flex items-center gap-1 text-xs font-medium text-blue-600">
                <TrendingUp className="h-3.5 w-3.5" />
                <span>{getDateRangeLabel(dateRange)}</span>
              </div>
            </div>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-200/60 text-blue-600">
              <MessageCircle className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div onClick={() => router.push('/inbox?filter=pending')} className="cursor-pointer relative rounded-xl border border-gray-200 bg-gradient-to-br from-amber-50 to-amber-100 p-5 shadow-sm transition-shadow hover:shadow-lg">
          <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-amber-500" />
          {filteredKpis.pendingReplies > 10 && (
            <span className="absolute -right-1 -top-1 flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
            </span>
          )}
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-500">Pending</p>
              <p className="mt-1 text-3xl font-bold text-gray-900">{filteredKpis.pendingReplies}</p>
              <p className="mt-1 text-xs text-gray-400">Awaiting review</p>
            </div>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-amber-200/60 text-amber-600">
              <Clock className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div onClick={() => router.push('/inbox?filter=ai_processed')} className="cursor-pointer relative rounded-xl border border-gray-200 bg-gradient-to-br from-teal-50 to-teal-100 p-5 shadow-sm transition-shadow hover:shadow-lg">
          <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-teal-600" />
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-500">AI Processed</p>
              <p className="mt-1 text-3xl font-bold text-gray-900">{filteredKpis.aiRepliesSent}</p>
              <div className="mt-2 flex items-center gap-1 text-xs font-medium text-teal-600">
                <TrendingUp className="h-3.5 w-3.5" />
                <span>{getDateRangeLabel(dateRange)}</span>
              </div>
            </div>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-teal-200/60 text-teal-600">
              <Bot className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div onClick={() => router.push('/reports')} className="cursor-pointer relative rounded-xl border border-gray-200 bg-gradient-to-br from-green-50 to-green-100 p-5 shadow-sm transition-shadow hover:shadow-lg">
          <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-green-600" />
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-500">Response Rate</p>
              <p className="mt-1 text-3xl font-bold text-gray-900">
                {filteredKpis.totalMessagesToday > 0
                  ? `${Math.round(((filteredKpis.aiRepliesSent) / filteredKpis.totalMessagesToday) * 100)}%`
                  : '--'}
              </p>
              <p className="mt-1 text-xs text-gray-400">AI replies / total</p>
            </div>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-green-200/60 text-green-600">
              <TrendingUp className="h-5 w-5" />
            </div>
          </div>
        </div>

        {/* Sentiment gauge card */}
        <div onClick={() => router.push('/inbox?sentiment=positive')} className="cursor-pointer relative rounded-xl border border-gray-200 bg-white p-5 shadow-sm hover:shadow-lg transition-shadow">
          <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-emerald-500" />
          <div className="flex items-start justify-between">
            <p className="text-sm font-medium text-gray-500">Sentiment Score</p>
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
              <Smile className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className="bg-green-500 transition-all"
              style={{ width: `${filteredKpis.sentimentScore.positive}%` }}
            />
            <div
              className="bg-gray-400 transition-all"
              style={{ width: `${filteredKpis.sentimentScore.neutral}%` }}
            />
            <div
              className="bg-red-500 transition-all"
              style={{ width: `${filteredKpis.sentimentScore.negative}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
              {filteredKpis.sentimentScore.positive}%
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-gray-400" />
              {filteredKpis.sentimentScore.neutral}%
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
              {filteredKpis.sentimentScore.negative}%
            </span>
          </div>
        </div>

        <div onClick={() => router.push(`/inbox?category=${encodeURIComponent(filteredKpis.topCategory.name)}`)} className="cursor-pointer">
          <KPICard
            title="Top Issue Category"
            value={filteredKpis.topCategory.name}
            subtitle={filteredKpis.topCategory.count > 0 ? `${filteredKpis.topCategory.count} messages` : 'No data yet'}
            trend="neutral"
            icon={Tag}
            color="text-amber-600"
          />
        </div>
      </div>

      {/* SLA Performance + Spam */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div onClick={() => router.push('/reports')} className="cursor-pointer relative rounded-xl border border-gray-200 bg-gradient-to-br from-indigo-50 to-indigo-100 p-5 shadow-sm transition-shadow hover:shadow-lg">
          <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-indigo-600" />
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-500">Avg Response Time</p>
              <p className="mt-1 text-3xl font-bold text-gray-900">
                {slaStats.avgResponseMins > 0
                  ? slaStats.avgResponseMins >= 60
                    ? `${Math.floor(slaStats.avgResponseMins / 60)}h ${slaStats.avgResponseMins % 60}m`
                    : `${slaStats.avgResponseMins}m`
                  : '--'}
              </p>
              <p className="mt-1 text-xs text-gray-400">From received to first reply</p>
            </div>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-200/60 text-indigo-600">
              <Timer className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div onClick={() => router.push('/reports')} className="cursor-pointer relative rounded-xl border border-gray-200 bg-gradient-to-br from-emerald-50 to-emerald-100 p-5 shadow-sm transition-shadow hover:shadow-lg">
          <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-emerald-600" />
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-500">SLA Compliance</p>
              <p className="mt-1 text-3xl font-bold text-gray-900">
                {slaStats.compliancePct}%
              </p>
              <p className="mt-1 text-xs text-gray-400">Replied within 4h threshold</p>
            </div>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-200/60 text-emerald-600">
              <ShieldCheck className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div onClick={() => router.push('/inbox?filter=sla_breached')} className="cursor-pointer relative rounded-xl border border-gray-200 bg-gradient-to-br from-red-50 to-red-100 p-5 shadow-sm transition-shadow hover:shadow-lg">
          <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-red-500" />
          {slaStats.breachedCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
            </span>
          )}
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-500">SLA Breached</p>
              <p className="mt-1 text-3xl font-bold text-gray-900">{slaStats.breachedCount}</p>
              <p className="mt-1 text-xs text-gray-400">Messages past critical threshold</p>
            </div>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-red-200/60 text-red-600">
              <ShieldAlert className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div onClick={() => router.push('/inbox?spam=true')} className="cursor-pointer relative rounded-xl border border-gray-200 bg-gradient-to-br from-orange-50 to-orange-100 p-5 shadow-sm transition-shadow hover:shadow-lg">
          <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-orange-500" />
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-500">Spam Filtered</p>
              <p className="mt-1 text-3xl font-bold text-gray-900">{spamFilteredToday}</p>
              <p className="mt-1 text-xs text-gray-400">{getDateRangeLabel(dateRange)}</p>
            </div>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-orange-200/60 text-orange-600">
              <AlertTriangle className="h-5 w-5" />
            </div>
          </div>
        </div>
      </div>

      {/* Channel Breakdown + Category Breakdown */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 animate-slide-up stagger-2 [&>*]:min-w-0">
        {/* Channel Breakdown */}
        <Card title="Channel Breakdown" description={`Message volume by channel ${getDateRangeLabel(dateRange)}`}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 [&>div]:min-w-0">
            {filteredChannelStats.map((stat) => (
              <div
                key={stat.channel}
                onClick={() => router.push(`/inbox?channel=${stat.channel}`)}
                className="cursor-pointer rounded-lg border border-gray-100 p-4 text-center hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-center gap-2">
                  {getChannelColoredIcon(stat.channel)}
                  <span className="font-semibold text-gray-900">
                    {getChannelLabel(stat.channel)}
                  </span>
                </div>
                <p className="mt-2 text-3xl font-bold text-gray-900">
                  {stat.messageCount}
                </p>
                <p className="text-xs text-gray-500">messages</p>
                <div className="mt-3 flex items-center justify-center gap-3 text-xs">
                  <span className="text-orange-600">
                    {stat.pendingCount} pending
                  </span>
                  <span className="text-blue-600">
                    {stat.aiSentCount} AI sent
                  </span>
                </div>
                {/* Channel color bar at bottom */}
                <div
                  className={`mt-3 h-1 w-full rounded-full ${getChannelBgColor(stat.channel)}`}
                />
              </div>
            ))}
          </div>
        </Card>

        {/* Category Breakdown - CSS bar chart */}
        <Card title="Category Breakdown" description="Messages by classification category">
          {categories.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">No data yet</p>
          ) : (
            <div className="space-y-3">
              {categories.map((cat) => (
                <div key={cat.category} onClick={() => router.push(`/inbox?category=${encodeURIComponent(cat.category)}`)} className="cursor-pointer flex items-center gap-3 rounded px-1 hover:bg-gray-50 transition-colors">
                  <span className="w-24 sm:w-32 flex-shrink-0 truncate text-sm text-gray-700">
                    {cat.category}
                  </span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <div className="h-6 flex-1 overflow-hidden rounded bg-gray-100">
                        <div
                          className="h-full rounded bg-teal-500 transition-all"
                          style={{
                            width: `${(cat.count / maxCategoryCount) * 100}%`,
                          }}
                        />
                      </div>
                      <span className="w-8 text-right text-sm font-semibold text-gray-700">
                        {cat.count}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Activity Feed */}
      <Card
        title="Activity Feed"
        description="Real-time activity across all channels"
        className="animate-slide-up stagger-3"
      >
        <ActivityFeed />
      </Card>

      {/* Accounts Overview Table */}
      <Card
        title="Accounts Overview"
        description={isAccountFiltered ? `Showing ${filteredAccounts.length} of ${accounts.length} accounts` : `All ${accounts.length} active company accounts`}
        className="animate-slide-up stagger-4"
      >
        {filteredAccounts.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">No accounts found</p>
        ) : (
          <AccountsTable accounts={filteredAccounts} filter={channelFilter} />
        )}
      </Card>
    </div>
  )
}
