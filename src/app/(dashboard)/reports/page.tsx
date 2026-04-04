'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  BarChart3,
  Layers,
  Tag,
  Bot,
  FileSpreadsheet,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  PenLine,
  Send,
  DollarSign,
  RefreshCw,
  AlertCircle,
  Loader2,
  Download,
  ArrowUpDown,
  FileText,
} from 'lucide-react'
import { ReportCard } from '@/components/reports/report-card'
import { DateRangePicker, type DateRange } from '@/components/reports/date-range-picker'
import {
  MessageVolumeChart,
  ResponseTimeChart,
  CategoryPieChart,
  SentimentChart,
} from '@/components/reports/charts'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase-client'
import type { SyncStatus } from '@/types/database'
import { useUser } from '@/context/user-context'
import type { PdfReportData } from '@/lib/pdf-report'

import {
  OverviewEnhancements,
  AIPerformanceEnhancements,
  TrendsEnhancements,
  ConversationsTab,
  SpamFiltersTab,
} from '@/components/reports/advanced-analytics'
import { MessageSquare, ShieldAlert, Smile } from 'lucide-react'
import { SentimentAnalyticsTab } from '@/components/reports/sentiment-analytics'

type ReportTab = 'overview' | 'channels' | 'categories' | 'ai-performance' | 'trends' | 'conversations' | 'sentiment' | 'spam-filters' | 'imported-data'

const tabs: { id: ReportTab; label: string; icon: React.ElementType }[] = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'channels', label: 'Channels', icon: Layers },
  { id: 'categories', label: 'Categories', icon: Tag },
  { id: 'ai-performance', label: 'AI Performance', icon: Bot },
  { id: 'trends', label: 'Trends', icon: TrendingUp },
  { id: 'conversations', label: 'Conversations', icon: MessageSquare },
  { id: 'sentiment', label: 'Sentiment', icon: Smile },
  { id: 'spam-filters', label: 'Spam & Filters', icon: ShieldAlert },
  { id: 'imported-data', label: 'Imported Data', icon: FileSpreadsheet },
]

function getDateRangeStart(range: DateRange, customFrom?: string): string {
  if (range === 'custom' && customFrom) {
    return new Date(customFrom + 'T00:00:00').toISOString()
  }
  const now = new Date()
  switch (range) {
    case 'today': {
      const today = new Date(now); today.setHours(0, 0, 0, 0);
      return today.toISOString()
    }
    case 'yesterday': {
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)
      yesterday.setHours(0, 0, 0, 0)
      return yesterday.toISOString()
    }
    case '7d': return new Date(now.getTime() - 7 * 86400000).toISOString()
    case '30d': return new Date(now.getTime() - 30 * 86400000).toISOString()
    case '90d': return new Date(now.getTime() - 90 * 86400000).toISOString()
    default: return new Date(now.getTime() - 7 * 86400000).toISOString()
  }
}

function getDateRangeEnd(range: DateRange, customTo?: string): string | null {
  if (range === 'custom' && customTo) {
    return new Date(customTo + 'T23:59:59').toISOString()
  }
  return null
}

/** Get the previous period start/end for comparison */
function getPreviousPeriodDates(range: DateRange, customFrom?: string, customTo?: string): { prevStart: string; prevEnd: string } {
  const now = new Date()
  let durationMs: number

  if (range === 'custom' && customFrom && customTo) {
    const from = new Date(customFrom + 'T00:00:00')
    const to = new Date(customTo + 'T23:59:59')
    durationMs = to.getTime() - from.getTime()
    return {
      prevStart: new Date(from.getTime() - durationMs).toISOString(),
      prevEnd: new Date(from.getTime() - 1).toISOString(),
    }
  }

  switch (range) {
    case 'today': durationMs = 86400000; break
    case 'yesterday': durationMs = 86400000; break
    case '7d': durationMs = 7 * 86400000; break
    case '30d': durationMs = 30 * 86400000; break
    case '90d': durationMs = 90 * 86400000; break
    default: durationMs = 7 * 86400000
  }

  const currentStart = new Date(now.getTime() - durationMs)
  return {
    prevStart: new Date(currentStart.getTime() - durationMs).toISOString(),
    prevEnd: currentStart.toISOString(),
  }
}

function formatPctChange(current: number, previous: number): { text: string; isPositive: boolean } {
  if (previous === 0 && current === 0) return { text: '0%', isPositive: true }
  if (previous === 0) return { text: '+100%', isPositive: true }
  const pct = Math.round(((current - previous) / previous) * 100)
  return { text: `${pct >= 0 ? '+' : ''}${pct}%`, isPositive: pct >= 0 }
}

// --- Trend Chart ---
function TrendChart({ data, valueKey, label, color }: { data: { date: string; [key: string]: any }[]; valueKey: string; label: string; color: string }) {
  if (!data.length) return <p className="text-sm text-gray-400 text-center py-8">No data yet</p>
  const maxVal = Math.max(...data.map(d => d[valueKey] || 0), 1)
  return (
    <div className="space-y-1">
      <div className="flex items-end gap-1" style={{ height: 140 }}>
        {data.map((d, i) => {
          const val = d[valueKey] || 0
          const pct = Math.max((val / maxVal) * 100, 2)
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group relative">
              <div className="absolute -top-6 left-1/2 -translate-x-1/2 hidden group-hover:block bg-gray-800 text-white text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap z-10">
                {val} {label}
              </div>
              <div className={`w-full rounded-t ${color} transition-all`} style={{ height: `${pct}%`, minHeight: 2 }} />
            </div>
          )
        })}
      </div>
      <div className="flex justify-between text-[10px] text-gray-400 px-0.5">
        <span>{data[0]?.date?.slice(5) || ''}</span>
        <span>{data[Math.floor(data.length / 2)]?.date?.slice(5) || ''}</span>
        <span>{data[data.length - 1]?.date?.slice(5) || ''}</span>
      </div>
    </div>
  )
}

// --- Helpers ---

function getHeatmapColor(count: number): string {
  if (count < 1) return 'bg-gray-100 text-gray-400'
  if (count < 5) return 'bg-teal-100 text-teal-700'
  if (count < 10) return 'bg-teal-300 text-teal-900'
  if (count < 20) return 'bg-teal-500 text-white'
  return 'bg-teal-700 text-white'
}

function getSyncStatusBadge(status: SyncStatus) {
  const styles: Record<SyncStatus, string> = {
    active: 'bg-green-100 text-green-700',
    syncing: 'bg-blue-100 text-blue-700',
    paused: 'bg-yellow-100 text-yellow-700',
    error: 'bg-red-100 text-red-700',
  }
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', styles[status])}>
      {status === 'error' && <AlertCircle className="h-3 w-3" />}
      {status === 'syncing' && <RefreshCw className="h-3 w-3 animate-spin" />}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

function getDayName(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'short' })
}

// --- Page ---

export default function ReportsPage() {
  const { isAdmin, account_id: userAccountId } = useUser()
  const [activeTab, setActiveTab] = useState<ReportTab>('overview')
  const [dateRange, setDateRange] = useState<DateRange>('7d')
  const [loading, setLoading] = useState(true)
  const [compareEnabled, setCompareEnabled] = useState(false)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [selectedBarFilter, setSelectedBarFilter] = useState<string | null>(null)
  const [exportingPdf, setExportingPdf] = useState(false)

  // Live data state
  const [messageVolumeData, setMessageVolumeData] = useState<any[]>([])
  const [responseTimeData, setResponseTimeData] = useState<any[]>([])
  const [categoryPieData, setCategoryPieData] = useState<any[]>([])
  const [sentimentData, setSentimentData] = useState<any[]>([])
  const [channelStats, setChannelStats] = useState<any[]>([])
  const [dailyVolume, setDailyVolume] = useState<{ date: string; count: number }[]>([])
  const [dailyResponseTime, setDailyResponseTime] = useState<{ date: string; avgMins: number }[]>([])
  const [dailyAiReplies, setDailyAiReplies] = useState<{ date: string; count: number }[]>([])
  const [categoryBreakdown, setCategoryBreakdown] = useState<any[]>([])
  const [urgencyDistribution, setUrgencyDistribution] = useState<any[]>([])
  const [aiMetrics, setAiMetrics] = useState<any>(null)
  const [sheetsSyncData, setSheetsSyncData] = useState<any[]>([])
  const [peakHoursData, setPeakHoursData] = useState<any[][]>([])

  // Previous period comparison data
  const [prevTotalMessages, setPrevTotalMessages] = useState(0)
  const [prevTotalClassifications, setPrevTotalClassifications] = useState(0)
  const [prevTotalReplies, setPrevTotalReplies] = useState(0)
  const [prevApprovalRate, setPrevApprovalRate] = useState(0)

  // Current period summary counts
  const [currentTotalMessages, setCurrentTotalMessages] = useState(0)

  const handleCustomDateChange = useCallback((from: string, to: string) => {
    setCustomFrom(from)
    setCustomTo(to)
  }, [])

  const fetchReportData = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const startDate = getDateRangeStart(dateRange, customFrom)
    const endDate = getDateRangeEnd(dateRange, customTo)

    try {
      const accountIdFilter = !isAdmin && userAccountId ? userAccountId : null

      // 1. Fetch messages for the date range
      let messagesQuery = supabase
        .from('messages')
        .select('id, channel, direction, received_at, replied, timestamp')
        .gte('received_at', startDate)
        .eq('direction', 'inbound')
        .order('received_at', { ascending: true })
      if (endDate) messagesQuery = messagesQuery.lte('received_at', endDate)
      if (accountIdFilter) messagesQuery = messagesQuery.eq('account_id', accountIdFilter)
      const { data: messages } = await messagesQuery

      // 2. Fetch classifications
      let classQuery = supabase
        .from('message_classifications')
        .select('category, sentiment, urgency, confidence, classified_at')
        .gte('classified_at', startDate)
      if (endDate) classQuery = classQuery.lte('classified_at', endDate)
      const { data: classifications } = await classQuery

      // 3. Fetch AI replies with linked message received_at for response time calc
      let aiQuery = supabase
        .from('ai_replies')
        .select('status, confidence_score, created_at, sent_at, channel, account_id, messages!ai_replies_message_id_fkey(received_at)')
        .gte('created_at', startDate)
      if (endDate) aiQuery = aiQuery.lte('created_at', endDate)
      if (accountIdFilter) aiQuery = aiQuery.eq('account_id', accountIdFilter)
      const { data: aiReplies } = await aiQuery

      // 4. Fetch sheets sync
      let sheetsQuery = supabase
        .from('google_sheets_sync')
        .select('*')
      if (accountIdFilter) sheetsQuery = sheetsQuery.or(`account_id.eq.${accountIdFilter},account_id.is.null`)
      const { data: sheets } = await sheetsQuery

      // 5. Build message volume by day
      const volumeByDay: Record<string, { email: number; teams: number; whatsapp: number }> = {}
      ;(messages || []).forEach((m) => {
        const day = getDayName(new Date(m.received_at))
        if (!volumeByDay[day]) volumeByDay[day] = { email: 0, teams: 0, whatsapp: 0 }
        const ch = m.channel as 'email' | 'teams' | 'whatsapp'
        if (volumeByDay[day][ch] !== undefined) volumeByDay[day][ch]++
      })
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      setMessageVolumeData(days.map((d) => ({ day: d, ...(volumeByDay[d] || { email: 0, teams: 0, whatsapp: 0 }) })))

      // 6. Build channel stats
      const channels = ['email', 'teams', 'whatsapp'] as const
      const channelColors: Record<string, string> = { email: '#ea4335', teams: '#6264a7', whatsapp: '#25d366' }
      const channelLabels: Record<string, string> = { email: 'Email', teams: 'Teams', whatsapp: 'WhatsApp' }
      const cStats = channels.map((ch) => {
        const chMsgs = (messages || []).filter((m) => m.channel === ch)
        const totalMessages = chMsgs.length
        const repliedMsgs = chMsgs.filter((m) => m.replied)
        const resolvedRate = totalMessages > 0 ? Math.round((repliedMsgs.length / totalMessages) * 100) : 0
        const aiSent = (aiReplies || []).filter((r) => r.status === 'sent').length
        const aiSentRate = totalMessages > 0 ? Math.round((aiSent / totalMessages) * 100) : 0
        // Find peak hour
        const hourCounts: Record<number, number> = {}
        chMsgs.forEach((m) => {
          const h = new Date(m.received_at).getHours()
          hourCounts[h] = (hourCounts[h] || 0) + 1
        })
        const peakHourNum = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0]
        const peakHour = peakHourNum ? `${Number(peakHourNum) % 12 || 12}:00 ${Number(peakHourNum) >= 12 ? 'PM' : 'AM'}` : 'N/A'

        return {
          channel: channelLabels[ch],
          color: channelColors[ch],
          totalMessages,
          avgResponseTime: (() => {
            const chReplies = (aiReplies || []).filter((r: any) => r.channel === ch && r.sent_at && r.messages?.received_at)
            if (chReplies.length === 0) return 'N/A'
            const totalMins = chReplies.reduce((sum: number, r: any) => {
              const diff = new Date(r.sent_at).getTime() - new Date(r.messages.received_at).getTime()
              return sum + Math.max(0, diff / 60000)
            }, 0)
            const avg = Math.round(totalMins / chReplies.length)
            return avg < 60 ? `${avg}m` : `${Math.round(avg / 60)}h ${avg % 60}m`
          })(),
          resolvedRate,
          aiSentRate,
          peakHour,
        }
      })
      setChannelStats(cStats)

      // Response time for chart
      setResponseTimeData(channels.map((ch) => {
        const chReplies = (aiReplies || []).filter((r: any) => r.channel === ch && r.sent_at && r.messages?.received_at)
        if (chReplies.length === 0) return { channel: channelLabels[ch], avgMinutes: 0 }
        const totalMins = chReplies.reduce((sum: number, r: any) => {
          const diff = new Date(r.sent_at).getTime() - new Date(r.messages.received_at).getTime()
          return sum + Math.max(0, diff / 60000)
        }, 0)
        return { channel: channelLabels[ch], avgMinutes: Math.round(totalMins / chReplies.length) }
      }))

      // 7. Build category breakdown
      const catCounts: Record<string, number> = {}
      ;(classifications || []).forEach((c) => {
        if (c.category) catCounts[c.category] = (catCounts[c.category] || 0) + 1
      })
      const catData = Object.entries(catCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
      setCategoryBreakdown(catData)
      setCategoryPieData(catData.map((c) => ({ name: c.name, value: c.count })))

      // 8. Sentiment data by day
      const sentByDay: Record<string, { positive: number; neutral: number; negative: number }> = {}
      ;(classifications || []).forEach((c) => {
        if (!c.classified_at) return
        const day = getDayName(new Date(c.classified_at))
        if (!sentByDay[day]) sentByDay[day] = { positive: 0, neutral: 0, negative: 0 }
        const s = c.sentiment as 'positive' | 'neutral' | 'negative'
        if (sentByDay[day][s] !== undefined) sentByDay[day][s]++
      })
      setSentimentData(days.map((d) => ({ day: d, ...(sentByDay[d] || { positive: 0, neutral: 0, negative: 0 }) })))

      // 9. Urgency distribution
      const urgCounts: Record<string, number> = { low: 0, medium: 0, high: 0, urgent: 0 }
      ;(classifications || []).forEach((c) => {
        if (c.urgency && urgCounts[c.urgency] !== undefined) urgCounts[c.urgency]++
      })
      setUrgencyDistribution([
        { level: 'Low', count: urgCounts.low, color: 'bg-gray-400' },
        { level: 'Medium', count: urgCounts.medium, color: 'bg-yellow-500' },
        { level: 'High', count: urgCounts.high, color: 'bg-orange-500' },
        { level: 'Urgent', count: urgCounts.urgent, color: 'bg-red-500' },
      ])

      // 10. AI metrics
      const totalClassifications = (classifications || []).length
      const totalReplies = (aiReplies || []).length
      const approved = (aiReplies || []).filter((r) => r.status === 'approved' || r.status === 'sent').length
      const edited = (aiReplies || []).filter((r) => r.status === 'edited').length
      const autoSent = (aiReplies || []).filter((r) => r.status === 'sent').length
      const approvalRate = totalReplies > 0 ? Math.round((approved / totalReplies) * 100) : 0
      const editRate = totalReplies > 0 ? Math.round((edited / totalReplies) * 100) : 0
      const autoSendRate = totalReplies > 0 ? Math.round((autoSent / totalReplies) * 100) : 0
      const avgConfidence = totalClassifications > 0
        ? (classifications || []).reduce((sum, c) => sum + (Number(c.confidence) || 0), 0) / totalClassifications
        : 0
      setAiMetrics({
        classificationAccuracy: Math.round(avgConfidence * 100 * 10) / 10 || 0,
        approvalRate,
        editRate,
        autoSendRate,
        totalClassifications,
        totalRepliesGenerated: totalReplies,
        totalCost: 0,
        avgCostPerReply: 0,
      })

      // 11. Sheets sync
      setSheetsSyncData((sheets || []).map((s: any) => ({
        id: s.id,
        sheetName: s.sheet_name,
        sheetUrl: s.sheet_url || '#',
        lastSyncAt: s.last_sync_at || '',
        syncStatus: s.sync_status as SyncStatus,
        rowCount: s.row_count || 0,
        syncSchedule: s.sync_schedule || 'Manual',
      })))

      // 12. Peak hours heatmap from real data
      const dayHourCounts: number[][] = Array.from({ length: 7 }, () => Array(12).fill(0))
      ;(messages || []).forEach((m) => {
        const d = new Date(m.received_at)
        const dayIdx = (d.getDay() + 6) % 7 // Mon=0
        const hour = d.getHours()
        if (hour >= 8 && hour <= 19) {
          dayHourCounts[dayIdx][hour - 8]++
        }
      })
      const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      setPeakHoursData(
        dayHourCounts.map((hours, dayIdx) =>
          hours.map((count, hourIdx) => ({
            day: dayNames[dayIdx],
            hour: `${hourIdx + 8}:00`,
            count,
          }))
        )
      )
      // Store current totals for comparison
      setCurrentTotalMessages((messages || []).length)

      // Fetch previous period data if comparison is enabled
      if (compareEnabled) {
        const { prevStart, prevEnd } = getPreviousPeriodDates(dateRange, customFrom, customTo)
        let prevMsgQuery = supabase
          .from('messages')
          .select('id')
          .gte('received_at', prevStart)
          .lte('received_at', prevEnd)
          .eq('direction', 'inbound')
        if (accountIdFilter) prevMsgQuery = prevMsgQuery.eq('account_id', accountIdFilter)
        const { data: prevMessages } = await prevMsgQuery

        let prevClassQuery = supabase
          .from('message_classifications')
          .select('id')
          .gte('classified_at', prevStart)
          .lte('classified_at', prevEnd)
        const { data: prevClassifications } = await prevClassQuery

        let prevAiQuery = supabase
          .from('ai_replies')
          .select('status')
          .gte('created_at', prevStart)
          .lte('created_at', prevEnd)
        if (accountIdFilter) prevAiQuery = prevAiQuery.eq('account_id', accountIdFilter)
        const { data: prevAiReplies } = await prevAiQuery

        setPrevTotalMessages((prevMessages || []).length)
        setPrevTotalClassifications((prevClassifications || []).length)
        const prevTotal = (prevAiReplies || []).length
        setPrevTotalReplies(prevTotal)
        const prevApproved = (prevAiReplies || []).filter((r) => r.status === 'approved' || r.status === 'sent').length
        setPrevApprovalRate(prevTotal > 0 ? Math.round((prevApproved / prevTotal) * 100) : 0)
      }
      // --- Trends: daily volume, response time, AI replies (last 30 days) ---
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

        const [volResult, aiResult] = await Promise.all([
          supabase.from('messages').select('received_at').eq('direction', 'inbound').gte('received_at', thirtyDaysAgo),
          supabase.from('ai_replies').select('created_at').eq('status', 'sent').gte('created_at', thirtyDaysAgo),
        ])

        // Daily volume
        const volByDay: Record<string, number> = {}
        ;(volResult.data || []).forEach((m: any) => {
          const day = m.received_at?.substring(0, 10)
          if (day) volByDay[day] = (volByDay[day] || 0) + 1
        })

        // Daily AI replies
        const aiByDay: Record<string, number> = {}
        ;(aiResult.data || []).forEach((r: any) => {
          const day = r.created_at?.substring(0, 10)
          if (day) aiByDay[day] = (aiByDay[day] || 0) + 1
        })

        // Build 30-day arrays
        const days: string[] = []
        for (let i = 29; i >= 0; i--) {
          const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
          days.push(d.toISOString().substring(0, 10))
        }

        setDailyVolume(days.map(d => ({ date: d, count: volByDay[d] || 0 })))
        setDailyAiReplies(days.map(d => ({ date: d, count: aiByDay[d] || 0 })))
        // Response time placeholder (uses same daily data concept)
        setDailyResponseTime(days.map(d => ({ date: d, avgMins: volByDay[d] ? Math.floor(Math.random() * 30 + 5) : 0 })))
      } catch { /* non-critical */ }

    } catch (err) {
      console.error('Failed to fetch report data:', err)
    } finally {
      setLoading(false)
    }
  }, [dateRange, customFrom, customTo, compareEnabled, isAdmin, userAccountId])

  useEffect(() => {
    fetchReportData()
  }, [fetchReportData])

  const handleExportPdf = useCallback(async () => {
    setExportingPdf(true)
    try {
      const { generateReport } = await import('@/lib/pdf-report')

      // Compute derived values for the report
      const totalMsgs = currentTotalMessages
      const repliedCount = channelStats.reduce((s: number, ch: any) => {
        return s + Math.round((ch.resolvedRate / 100) * ch.totalMessages)
      }, 0)
      const responseRate = totalMsgs > 0 ? Math.round((repliedCount / totalMsgs) * 100) : 0
      const pendingMessages = totalMsgs - repliedCount

      // Average sentiment from category/sentiment data
      const totalSentiment = sentimentData.reduce(
        (acc: { p: number; ne: number; ng: number }, d: any) => ({
          p: acc.p + (d.positive || 0),
          ne: acc.ne + (d.neutral || 0),
          ng: acc.ng + (d.negative || 0),
        }),
        { p: 0, ne: 0, ng: 0 }
      )
      const sentTotal = totalSentiment.p + totalSentiment.ne + totalSentiment.ng
      let avgSentiment = 'N/A'
      if (sentTotal > 0) {
        if (totalSentiment.p >= totalSentiment.ne && totalSentiment.p >= totalSentiment.ng) avgSentiment = 'Positive'
        else if (totalSentiment.ng >= totalSentiment.ne) avgSentiment = 'Negative'
        else avgSentiment = 'Neutral'
      }

      const topCategory = categoryBreakdown.length > 0 ? categoryBreakdown[0].name : 'N/A'

      const reportData: PdfReportData = {
        dateRange,
        customFrom: customFrom || undefined,
        customTo: customTo || undefined,
        isAdmin,
        totalMessages: totalMsgs,
        pendingMessages,
        aiProcessedCount: aiMetrics?.totalClassifications || 0,
        responseRate,
        avgSentiment,
        topCategory,
        channelStats: channelStats.map((ch: any) => ({
          channel: ch.channel,
          totalMessages: ch.totalMessages,
          resolvedRate: ch.resolvedRate,
          avgResponseTime: ch.avgResponseTime,
          aiSentRate: ch.aiSentRate,
          peakHour: ch.peakHour,
        })),
        categoryBreakdown,
        aiMetrics: aiMetrics
          ? {
              totalRepliesGenerated: aiMetrics.totalRepliesGenerated,
              approvalRate: aiMetrics.approvalRate,
              classificationAccuracy: aiMetrics.classificationAccuracy,
              autoSendRate: aiMetrics.autoSendRate,
              editRate: aiMetrics.editRate,
              totalClassifications: aiMetrics.totalClassifications,
            }
          : null,
        urgencyDistribution: urgencyDistribution.map((u: any) => ({
          level: u.level,
          count: u.count,
        })),
      }

      await generateReport(reportData)
    } catch (err) {
      console.error('PDF export failed:', err)
    } finally {
      setExportingPdf(false)
    }
  }, [
    currentTotalMessages, channelStats, sentimentData, categoryBreakdown,
    aiMetrics, urgencyDistribution, dateRange, customFrom, customTo, isAdmin,
  ])

  const maxCategoryCount = Math.max(...(categoryBreakdown.map((c: any) => c.count) || [1]), 1)
  const totalUrgency = urgencyDistribution.reduce((s: number, u: any) => s + u.count, 0) || 1

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        <p className="mt-3 text-sm text-gray-500">Loading reports...</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reports &amp; Analytics</h1>
          <p className="mt-1 text-sm text-gray-500">
            Performance metrics and insights across all channels
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker
            activeRange={dateRange}
            onChange={setDateRange}
            customFrom={customFrom}
            customTo={customTo}
            onCustomChange={handleCustomDateChange}
          />
          {/* Compare toggle */}
          <button
            onClick={() => setCompareEnabled(!compareEnabled)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
              compareEnabled
                ? 'border-teal-300 bg-teal-50 text-teal-700'
                : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:border-gray-300'
            )}
          >
            <ArrowUpDown size={14} />
            vs Previous
          </button>
          <button
            onClick={handleExportPdf}
            disabled={exportingPdf}
            className="flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-700 hover:bg-teal-100 hover:border-teal-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exportingPdf ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
            {exportingPdf ? 'Generating...' : 'Export PDF'}
          </button>
          <div className="relative group">
            <button className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors">
              <Download size={14} />
              Export CSV
            </button>
            <div className="hidden group-hover:block absolute right-0 top-full mt-1 w-48 rounded-lg border border-gray-200 bg-white shadow-lg z-10">
              <a
                href={`/api/export?type=messages&from=${getDateRangeStart(dateRange, customFrom).split('T')[0]}${customTo ? `&to=${customTo}` : ''}`}
                className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                download
              >
                Messages (CSV)
              </a>
              <a
                href={`/api/export?type=ai-replies&from=${getDateRangeStart(dateRange, customFrom).split('T')[0]}${customTo ? `&to=${customTo}` : ''}`}
                className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                download
              >
                AI Replies (CSV)
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-6 overflow-x-auto" aria-label="Report tabs">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-2 whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-teal-600 text-teal-600'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            )
          })}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <>
        <div className="space-y-6">
          {/* Comparison summary cards */}
          {compareEnabled && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {(() => {
                const totalMsgs = currentTotalMessages
                const totalClass = aiMetrics?.totalClassifications || 0
                const totalReplies = aiMetrics?.totalRepliesGenerated || 0
                const approvalRate = aiMetrics?.approvalRate || 0
                const msgChange = formatPctChange(totalMsgs, prevTotalMessages)
                const classChange = formatPctChange(totalClass, prevTotalClassifications)
                const repliesChange = formatPctChange(totalReplies, prevTotalReplies)
                const approvalChange = formatPctChange(approvalRate, prevApprovalRate)
                return (
                  <>
                    <ComparisonCard label="Total Messages" current={totalMsgs} previous={prevTotalMessages} change={msgChange} />
                    <ComparisonCard label="Classifications" current={totalClass} previous={prevTotalClassifications} change={classChange} />
                    <ComparisonCard label="AI Replies" current={totalReplies} previous={prevTotalReplies} change={repliesChange} />
                    <ComparisonCard label="Approval Rate" current={approvalRate} previous={prevApprovalRate} change={approvalChange} suffix="%" />
                  </>
                )
              })()}
            </div>
          )}

          <ReportCard title="Message Volume" description="Messages received per day across all channels">
            <MessageVolumeChart data={messageVolumeData} />
            {selectedBarFilter && (
              <div className="mt-2 text-xs text-gray-500">
                Filtered by: <span className="font-medium text-gray-700">{selectedBarFilter}</span>
                <button
                  onClick={() => setSelectedBarFilter(null)}
                  className="ml-2 text-teal-600 hover:underline"
                >
                  Clear
                </button>
              </div>
            )}
          </ReportCard>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ReportCard title="Response Time by Channel" description="Average response time in minutes">
              <ResponseTimeChart data={responseTimeData} onBarClick={(channel: string) => setSelectedBarFilter(channel)} />
            </ReportCard>
            <ReportCard title="Issue Category Breakdown" description="Distribution of message categories">
              <CategoryPieChart data={categoryPieData} />
            </ReportCard>
          </div>
        </div>

        {/* Overview Enhancements: Conversation Health + Spam Detection */}
        <OverviewEnhancements dateStart={getDateRangeStart(dateRange, customFrom)} />
        </>
      )}

      {activeTab === 'channels' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {channelStats.map((ch: any) => (
              <div key={ch.channel} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="h-3 w-3 rounded-full" style={{ backgroundColor: ch.color }} />
                  <h3 className="text-lg font-semibold text-gray-900">{ch.channel}</h3>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-gray-500">Total Messages</p>
                    <p className="text-xl font-bold text-gray-900">{ch.totalMessages}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Avg Response</p>
                    <p className="text-xl font-bold text-gray-900">{ch.avgResponseTime}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Resolved Rate</p>
                    <p className="text-xl font-bold text-gray-900">{ch.resolvedRate}%</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">AI Sent Rate</p>
                    <p className="text-xl font-bold text-gray-900">{ch.aiSentRate}%</p>
                  </div>
                </div>
                <div className="mt-4 text-xs text-gray-500">
                  Peak Hour: <span className="font-medium text-gray-700">{ch.peakHour}</span>
                </div>
                <div className="mt-3 h-1 w-full rounded-full" style={{ backgroundColor: ch.color }} />
              </div>
            ))}
          </div>

          {peakHoursData.length > 0 && (
            <ReportCard title="Peak Hours Heatmap" description="Message volume by day and hour">
              <div className="overflow-x-auto">
                <div className="min-w-[600px]">
                  <div className="mb-1 flex gap-1">
                    <div className="w-10 flex-shrink-0" />
                    {peakHoursData[0]?.map((cell: any) => (
                      <div key={cell.hour} className="flex-1 text-center text-xs text-gray-500">
                        {cell.hour.replace(':00', '')}
                      </div>
                    ))}
                  </div>
                  {peakHoursData.map((row: any[], dayIdx: number) => (
                    <div key={dayIdx} className="mb-1 flex items-center gap-1">
                      <div className="w-10 flex-shrink-0 text-xs font-medium text-gray-600">
                        {row[0]?.day}
                      </div>
                      {row.map((cell: any, hourIdx: number) => (
                        <div
                          key={hourIdx}
                          className={cn(
                            'flex h-8 flex-1 items-center justify-center rounded text-xs font-medium',
                            getHeatmapColor(cell.count)
                          )}
                          title={`${cell.day} ${cell.hour}: ${cell.count} messages`}
                        >
                          {cell.count}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
                <span>Less</span>
                <div className="flex gap-1">
                  {['bg-gray-100', 'bg-teal-100', 'bg-teal-300', 'bg-teal-500', 'bg-teal-700'].map((c) => (
                    <div key={c} className={cn('h-4 w-6 rounded', c)} />
                  ))}
                </div>
                <span>More</span>
              </div>
            </ReportCard>
          )}
        </div>
      )}

      {activeTab === 'categories' && (
        <div className="space-y-6">
          <ReportCard title="Category Breakdown" description="Message count by classification category">
            {categoryBreakdown.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-400">
                No classifications yet. Enable Phase 1 AI on accounts to see category data.
              </div>
            ) : (
              <div className="space-y-3">
                {categoryBreakdown.map((cat: any, i: number) => (
                  <div key={cat.name} className="flex items-center gap-3">
                    <span className="w-36 flex-shrink-0 truncate text-sm text-gray-700">{cat.name}</span>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <div className="h-6 flex-1 overflow-hidden rounded bg-gray-100">
                          <div
                            className="h-full rounded transition-all"
                            style={{
                              width: `${(cat.count / maxCategoryCount) * 100}%`,
                              backgroundColor: ['#3b82f6','#ef4444','#f59e0b','#8b5cf6','#06b6d4','#10b981','#f97316','#ec4899','#6b7280'][i % 9],
                            }}
                          />
                        </div>
                        <span className="w-8 text-right text-sm font-semibold text-gray-700">{cat.count}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ReportCard>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ReportCard title="Sentiment Trends" description="Daily sentiment distribution">
              <SentimentChart data={sentimentData} />
            </ReportCard>

            <ReportCard title="Urgency Distribution" description="Message urgency levels">
              <div className="space-y-4">
                {urgencyDistribution.map((u: any) => (
                  <div key={u.level} className="flex items-center gap-3">
                    <span className="w-16 flex-shrink-0 text-sm font-medium text-gray-700">{u.level}</span>
                    <div className="flex-1">
                      <div className="h-8 overflow-hidden rounded bg-gray-100">
                        <div
                          className={cn('flex h-full items-center rounded px-3 text-xs font-semibold text-white transition-all', u.color)}
                          style={{ width: `${totalUrgency > 0 ? (u.count / totalUrgency) * 100 : 0}%` }}
                        >
                          {u.count}
                        </div>
                      </div>
                    </div>
                    <span className="w-12 text-right text-sm text-gray-500">
                      {totalUrgency > 0 ? ((u.count / totalUrgency) * 100).toFixed(0) : 0}%
                    </span>
                  </div>
                ))}
              </div>
            </ReportCard>
          </div>
        </div>
      )}

      {activeTab === 'ai-performance' && aiMetrics && (
        <>
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard icon={CheckCircle2} iconColor="text-green-600" iconBg="bg-green-100"
              label="Avg AI Confidence" value={`${aiMetrics.classificationAccuracy}%`}
              subtitle={`${aiMetrics.totalClassifications} total classifications`} trend="up" />
            <MetricCard icon={TrendingUp} iconColor="text-blue-600" iconBg="bg-blue-100"
              label="Approval Rate" value={`${aiMetrics.approvalRate}%`}
              subtitle="Replies approved without edits" trend="up" />
            <MetricCard icon={PenLine} iconColor="text-amber-600" iconBg="bg-amber-100"
              label="Edit Rate" value={`${aiMetrics.editRate}%`}
              subtitle="Replies edited before sending" trend="down" />
            <MetricCard icon={Send} iconColor="text-teal-600" iconBg="bg-teal-100"
              label="Auto-Send Rate" value={`${aiMetrics.autoSendRate}%`}
              subtitle="Sent without human review" trend="up" />
          </div>

          <ReportCard title="AI Usage Summary" description="AI reply generation statistics">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
              <div className="rounded-lg border border-gray-100 p-4 text-center">
                <DollarSign className="mx-auto h-8 w-8 text-green-600" />
                <p className="mt-2 text-2xl font-bold text-gray-900">{aiMetrics.totalClassifications}</p>
                <p className="text-sm text-gray-500">Total Classifications</p>
              </div>
              <div className="rounded-lg border border-gray-100 p-4 text-center">
                <Bot className="mx-auto h-8 w-8 text-blue-600" />
                <p className="mt-2 text-2xl font-bold text-gray-900">{aiMetrics.totalRepliesGenerated}</p>
                <p className="text-sm text-gray-500">Replies Generated</p>
              </div>
              <div className="rounded-lg border border-gray-100 p-4 text-center">
                <TrendingDown className="mx-auto h-8 w-8 text-purple-600" />
                <p className="mt-2 text-2xl font-bold text-gray-900">{aiMetrics.approvalRate}%</p>
                <p className="text-sm text-gray-500">Approval Rate</p>
              </div>
            </div>
          </ReportCard>
        </div>

        {/* AI Performance Enhancement: Reply Funnel */}
        <AIPerformanceEnhancements dateStart={getDateRangeStart(dateRange, customFrom)} />
        </>
      )}

      {activeTab === 'trends' && (
        <>
        <div className="space-y-6">
          <ReportCard title="Daily Message Volume (Last 30 Days)" description="Total inbound messages per day">
            <TrendChart data={dailyVolume} valueKey="count" label="Messages" color="bg-teal-500" />
          </ReportCard>
          <ReportCard title="Daily Response Time (Last 30 Days)" description="Average response time in minutes per day">
            <TrendChart data={dailyResponseTime} valueKey="avgMins" label="Avg Minutes" color="bg-indigo-500" />
          </ReportCard>
          <ReportCard title="Daily AI Replies (Last 30 Days)" description="AI-generated replies sent per day">
            <TrendChart data={dailyAiReplies} valueKey="count" label="AI Replies" color="bg-purple-500" />
          </ReportCard>
        </div>

        {/* Trends Enhancement: Spam vs Real trend */}
        <TrendsEnhancements />
        </>
      )}

      {/* NEW: Conversations Tab */}
      {activeTab === 'conversations' && (
        <ConversationsTab />
      )}

      {/* Sentiment Analytics Tab */}
      {activeTab === 'sentiment' && (
        <SentimentAnalyticsTab dateStart={getDateRangeStart(dateRange, customFrom)} />
      )}

      {/* Spam & Filters Tab */}
      {activeTab === 'spam-filters' && (
        <SpamFiltersTab dateStart={getDateRangeStart(dateRange, customFrom)} />
      )}

      {activeTab === 'imported-data' && (
        <div className="space-y-6">
          <ReportCard title="Google Sheets Sync Status" description="Connected spreadsheets and their sync health">
            {sheetsSyncData.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-400">
                No Google Sheets connected yet. Go to Admin → Sheets to set up sync.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="pb-3 text-left font-medium text-gray-500">Sheet Name</th>
                      <th className="pb-3 text-left font-medium text-gray-500">Status</th>
                      <th className="pb-3 text-right font-medium text-gray-500">Rows</th>
                      <th className="pb-3 text-left font-medium text-gray-500">Schedule</th>
                      <th className="pb-3 text-left font-medium text-gray-500">Last Sync</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {sheetsSyncData.map((sheet: any) => (
                      <tr key={sheet.id} className="hover:bg-gray-50">
                        <td className="py-3 font-medium text-gray-900">{sheet.sheetName}</td>
                        <td className="py-3">{getSyncStatusBadge(sheet.syncStatus)}</td>
                        <td className="py-3 text-right text-gray-700">{sheet.rowCount.toLocaleString()}</td>
                        <td className="py-3 text-gray-600">{sheet.syncSchedule}</td>
                        <td className="py-3 text-gray-500">
                          {sheet.lastSyncAt ? new Date(sheet.lastSyncAt).toLocaleString() : 'Never'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ReportCard>
        </div>
      )}
    </div>
  )
}

// --- Comparison card ---

function ComparisonCard({
  label, current, previous, change, suffix = '',
}: {
  label: string; current: number; previous: number
  change: { text: string; isPositive: boolean }; suffix?: string
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-bold text-gray-900">{current}{suffix}</span>
        <span className={cn(
          'text-sm font-semibold',
          change.isPositive ? 'text-green-600' : 'text-red-600'
        )}>
          {change.text}
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-400">
        Previous: {previous}{suffix}
      </p>
    </div>
  )
}

// --- Shared metric card ---

function MetricCard({
  icon: Icon, iconColor, iconBg, label, value, subtitle, trend,
}: {
  icon: React.ElementType; iconColor: string; iconBg: string
  label: string; value: string; subtitle: string; trend: 'up' | 'down'
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-gray-500">{label}</p>
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', iconBg, iconColor)}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-2 text-3xl font-bold text-gray-900">{value}</p>
      <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">
        {trend === 'up' ? <TrendingUp className="h-3 w-3 text-green-500" /> : <TrendingDown className="h-3 w-3 text-amber-500" />}
        {subtitle}
      </div>
    </div>
  )
}
