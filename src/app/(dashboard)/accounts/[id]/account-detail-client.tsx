'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  MessageCircle,
  AlertCircle,
  Brain,
  Clock,
  ArrowLeft,
  Zap,
  Eye,
  Bot,
  Shield,
  ShieldAlert,
  X,
  Mail,
} from 'lucide-react'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { PhaseIndicator } from '@/components/ui/phase-indicator'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { DateRangePicker, type DateRange } from '@/components/reports/date-range-picker'
import { createClient } from '@/lib/supabase-client'
import {
  cn,
  timeAgo,
  getChannelLabel,
  getSentimentColor,
  getUrgencyColor,
} from '@/lib/utils'
import type { Account, Category, Sentiment, Urgency, ConversationStatus } from '@/types/database'

const categoryColors: Record<string, string> = {
  'Trouble Ticket': 'bg-red-400',
  'Sales Inquiry': 'bg-blue-400',
  'Payment Issue': 'bg-orange-400',
  'Service Problem': 'bg-yellow-400',
  'Technical Issue': 'bg-purple-400',
  'Billing Question': 'bg-teal-400',
  'Connection Issue': 'bg-pink-400',
  'Rate Issue': 'bg-indigo-400',
  'General Inquiry': 'bg-gray-400',
}

const cssColorMap: Record<string, string> = {
  'bg-red-400': '#f87171',
  'bg-blue-400': '#60a5fa',
  'bg-orange-400': '#fb923c',
  'bg-yellow-400': '#facc15',
  'bg-purple-400': '#c084fc',
  'bg-teal-400': '#2dd4bf',
  'bg-pink-400': '#f472b6',
  'bg-indigo-400': '#818cf8',
  'bg-gray-400': '#9ca3af',
}

interface ConversationItem {
  id: string
  participantName: string
  preview: string
  category: Category
  sentiment: Sentiment
  urgency: Urgency
  timestamp: string
  status: ConversationStatus
}

interface CategoryBreakdown {
  category: Category
  count: number
  pct: number
}

interface Stats {
  total: number
  pending: number
  aiSendRate: number
  avgProcessingTime: number
  spam: number
}

type DrillDownType = 'total' | 'pending' | 'ai_sent' | 'spam' | null

interface DrillDownMessage {
  id: string
  sender_name: string | null
  email_subject: string | null
  message_text: string | null
  received_at: string
  replied: boolean
  is_spam: boolean
  conversation_id: string
}

export function AccountDetailClient({ account }: { account: Account }) {
  const [dateRange, setDateRange] = useState<DateRange>('30d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<Stats>({ total: 0, pending: 0, aiSendRate: 0, avgProcessingTime: 0, spam: 0 })
  const [categories, setCategories] = useState<CategoryBreakdown[]>([])
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [drillDown, setDrillDown] = useState<DrillDownType>(null)
  const [drillDownMessages, setDrillDownMessages] = useState<DrillDownMessage[]>([])
  const [drillDownLoading, setDrillDownLoading] = useState(false)

  const getStartDate = useCallback((): string | null => {
    const now = new Date()
    switch (dateRange) {
      case 'today': {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        return d.toISOString()
      }
      case '7d': {
        const d = new Date(now)
        d.setDate(d.getDate() - 7)
        return d.toISOString()
      }
      case '30d': {
        const d = new Date(now)
        d.setDate(d.getDate() - 30)
        return d.toISOString()
      }
      case '90d': {
        const d = new Date(now)
        d.setDate(d.getDate() - 90)
        return d.toISOString()
      }
      case 'custom': {
        if (customFrom) return new Date(customFrom).toISOString()
        return null
      }
      default:
        return null
    }
  }, [dateRange, customFrom])

  useEffect(() => {
    let cancelled = false

    async function fetchData() {
      setLoading(true)
      const supabase = createClient()
      const startDate = getStartDate()
      const id = account.id

      // Total messages
      let msgQuery = supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('account_id', id)
      if (startDate) msgQuery = msgQuery.gte('received_at', startDate)
      const { count: totalMessages } = await msgQuery

      // Pending replies
      let pendingQuery = supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('account_id', id)
        .eq('reply_required', true)
        .eq('replied', false)
      if (startDate) pendingQuery = pendingQuery.gte('received_at', startDate)
      const { count: pendingReplies } = await pendingQuery

      // Spam count
      let spamQuery = supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('account_id', id)
        .eq('is_spam', true)
      if (startDate) spamQuery = spamQuery.gte('received_at', startDate)
      const { count: spamCount } = await spamQuery

      // AI replies
      let aiQuery = supabase
        .from('ai_replies')
        .select('status, confidence_score')
        .eq('account_id', id)
      if (startDate) aiQuery = aiQuery.gte('created_at', startDate)
      const { data: aiReplies } = await aiQuery

      const totalAiReplies = (aiReplies || []).length
      const sentAiReplies = (aiReplies || []).filter(
        (r: { status: string }) => r.status === 'sent'
      ).length
      const aiSendRate = totalAiReplies > 0
        ? Math.round((sentAiReplies / totalAiReplies) * 100)
        : 0

      // Avg AI processing time
      let rtQuery = supabase
        .from('ai_replies')
        .select('sent_at, created_at')
        .eq('account_id', id)
        .not('sent_at', 'is', null)
      if (startDate) rtQuery = rtQuery.gte('created_at', startDate)
      const { data: responseTimes } = await rtQuery

      let avgProcessingTime = 0
      if (responseTimes && responseTimes.length > 0) {
        const validTimes = responseTimes.filter(
          (r: { sent_at: string | null; created_at: string | null }) => r.sent_at != null && r.created_at != null
        )
        if (validTimes.length > 0) {
          const totalMinutes = validTimes.reduce((sum: number, r: { sent_at: string; created_at: string }) => {
            const diff = new Date(r.sent_at).getTime() - new Date(r.created_at).getTime()
            return sum + diff / 60000
          }, 0)
          avgProcessingTime = Math.round(totalMinutes / validTimes.length)
        }
      }

      // Classification breakdown
      let classQuery = supabase
        .from('message_classifications')
        .select('category, message_id, classified_at, messages!inner(account_id)')
        .eq('messages.account_id', id)
      if (startDate) classQuery = classQuery.gte('classified_at', startDate)
      const { data: classificationRows } = await classQuery

      const catMap = new Map<string, number>()
      ;(classificationRows || []).forEach((row: { category: string }) => {
        catMap.set(row.category, (catMap.get(row.category) || 0) + 1)
      })
      const classTotal = Array.from(catMap.values()).reduce((a, b) => a + b, 0)
      const catBreakdown = Array.from(catMap.entries())
        .map(([category, count]) => ({
          category: category as Category,
          count,
          pct: classTotal > 0 ? Math.round((count / classTotal) * 100) : 0,
        }))
        .sort((a, b) => b.count - a.count)

      // Recent conversations
      let convQuery = supabase
        .from('conversations')
        .select('id, participant_name, status, priority, last_message_at, created_at')
        .eq('account_id', id)
        .order('last_message_at', { ascending: false })
        .limit(6)
      if (startDate) convQuery = convQuery.gte('last_message_at', startDate)
      const { data: conversationRows } = await convQuery

      const convItems: ConversationItem[] = await Promise.all(
        (conversationRows || []).map(async (conv: {
          id: string
          participant_name: string | null
          status: string
          priority: string
          last_message_at: string | null
          created_at: string
        }) => {
          const { data: latestMsg } = await supabase
            .from('messages')
            .select('message_text, timestamp')
            .eq('conversation_id', conv.id)
            .order('timestamp', { ascending: false })
            .limit(1)
            .maybeSingle()

          const { data: msgIds } = await supabase
            .from('messages')
            .select('id')
            .eq('conversation_id', conv.id)

          const { data: latestClassification } = await supabase
            .from('message_classifications')
            .select('category, sentiment, urgency')
            .in('message_id', (msgIds || []).map((m: { id: string }) => m.id))
            .order('classified_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          return {
            id: conv.id,
            participantName: conv.participant_name || 'Unknown',
            preview: latestMsg?.message_text?.slice(0, 80) || 'No messages',
            category: (latestClassification?.category || 'General Inquiry') as Category,
            sentiment: (latestClassification?.sentiment || 'neutral') as Sentiment,
            urgency: (latestClassification?.urgency || 'low') as Urgency,
            timestamp: latestMsg?.timestamp || conv.last_message_at || conv.created_at,
            status: conv.status as ConversationStatus,
          }
        })
      )

      if (!cancelled) {
        setStats({
          total: totalMessages || 0,
          pending: pendingReplies || 0,
          aiSendRate: totalAiReplies > 0 ? aiSendRate : 0,
          avgProcessingTime,
          spam: spamCount || 0,
        })
        setDrillDown(null)
        setDrillDownMessages([])
        setCategories(catBreakdown)
        setConversations(convItems)
        setLoading(false)
      }
    }

    fetchData()
    return () => { cancelled = true }
  }, [account.id, dateRange, customFrom, customTo, getStartDate])

  const handleCustomChange = (from: string, to: string) => {
    setCustomFrom(from)
    setCustomTo(to)
  }

  const handleKpiClick = async (type: DrillDownType) => {
    if (drillDown === type) {
      setDrillDown(null)
      setDrillDownMessages([])
      return
    }
    setDrillDown(type)
    setDrillDownLoading(true)
    const supabase = createClient()
    const startDate = getStartDate()

    let query = supabase
      .from('messages')
      .select('id, sender_name, email_subject, message_text, received_at, replied, is_spam, conversation_id')
      .eq('account_id', account.id)
      .eq('direction', 'inbound')
      .order('received_at', { ascending: false })
      .limit(50)

    if (startDate) query = query.gte('received_at', startDate)

    switch (type) {
      case 'pending':
        query = query.eq('reply_required', true).eq('replied', false).eq('is_spam', false)
        break
      case 'spam':
        query = query.eq('is_spam', true)
        break
      case 'ai_sent':
        // For AI sent, we fetch AI replies instead
        break
      case 'total':
      default:
        query = query.eq('is_spam', false)
        break
    }

    if (type === 'ai_sent') {
      let aiQuery = supabase
        .from('ai_replies')
        .select('id, draft_text, status, created_at, channel, messages!ai_replies_message_id_fkey(sender_name, email_subject, conversation_id)')
        .eq('account_id', account.id)
        .eq('status', 'sent')
        .order('created_at', { ascending: false })
        .limit(50)
      if (startDate) aiQuery = aiQuery.gte('created_at', startDate)
      const { data } = await aiQuery
      const mapped: DrillDownMessage[] = (data || []).map((r: Record<string, unknown>) => {
        const msg = r.messages as Record<string, unknown> | null
        return {
          id: r.id as string,
          sender_name: (msg?.sender_name as string) || null,
          email_subject: (msg?.email_subject as string) || null,
          message_text: (r.draft_text as string) || null,
          received_at: r.created_at as string,
          replied: true,
          is_spam: false,
          conversation_id: (msg?.conversation_id as string) || '',
        }
      })
      setDrillDownMessages(mapped)
    } else {
      const { data } = await query
      setDrillDownMessages((data || []) as DrillDownMessage[])
    }
    setDrillDownLoading(false)
  }

  const drillDownTitle: Record<string, string> = {
    total: 'All Messages',
    pending: 'Pending Replies',
    ai_sent: 'AI Sent Replies',
    spam: 'Spam Messages',
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/accounts"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-teal-700 transition-colors"
      >
        <ArrowLeft size={16} />
        Back to accounts
      </Link>

      {/* Account header */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-gray-50">
              <ChannelIcon channel={account.channel_type} size={28} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">{account.name}</h1>
              <div className="mt-1 flex items-center gap-3">
                <span className="text-sm text-gray-500">{getChannelLabel(account.channel_type)}</span>
                <PhaseIndicator
                  phase1_enabled={account.phase1_enabled}
                  phase2_enabled={account.phase2_enabled}
                />
              </div>
              {account.gmail_address && (
                <p className="mt-1 text-sm text-teal-600">
                  Monitoring &amp; replying via: {account.gmail_address}
                </p>
              )}
              {account.whatsapp_phone && (
                <p className="mt-1 text-sm text-green-600">
                  WhatsApp: {account.whatsapp_phone}
                </p>
              )}
            </div>
          </div>

          {/* Toggle switches preview */}
          <div className="flex flex-wrap gap-3">
            <div className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium',
              account.phase1_enabled ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-400'
            )}>
              <Eye size={14} />
              Phase 1
            </div>
            <div className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium',
              account.phase2_enabled ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-400'
            )}>
              <Zap size={14} />
              Phase 2
            </div>
            <div className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium',
              account.ai_auto_reply ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-400'
            )}>
              <Bot size={14} />
              Auto Reply
            </div>
            <div className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium',
              account.ai_trust_mode ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-400'
            )}>
              <Shield size={14} />
              Trust Mode
            </div>
          </div>
        </div>
      </div>

      {/* Date range picker */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-gray-600">Period:</span>
        <DateRangePicker
          activeRange={dateRange}
          onChange={setDateRange}
          customFrom={customFrom}
          customTo={customTo}
          onCustomChange={handleCustomChange}
        />
      </div>

      {/* Stats row */}
      {loading ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm animate-pulse">
              <div className="h-4 w-24 bg-gray-200 rounded" />
              <div className="mt-3 h-8 w-16 bg-gray-200 rounded" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <div
            className={cn(
              'rounded-xl border bg-white px-5 py-4 shadow-sm cursor-pointer hover:shadow-md transition-all',
              drillDown === 'total' ? 'border-teal-500 ring-2 ring-teal-100' : 'border-gray-200 hover:border-teal-300'
            )}
            onClick={() => handleKpiClick('total')}
          >
            <div className="flex items-center gap-2 text-gray-500">
              <MessageCircle size={16} />
              <span className="text-sm">Total Messages</span>
            </div>
            <p className="mt-2 text-2xl font-bold text-gray-900">{stats.total}</p>
          </div>
          <div
            className={cn(
              'rounded-xl border bg-white px-5 py-4 shadow-sm cursor-pointer hover:shadow-md transition-all',
              drillDown === 'pending' ? 'border-orange-500 ring-2 ring-orange-100' : 'border-gray-200 hover:border-orange-300'
            )}
            onClick={() => handleKpiClick('pending')}
          >
            <div className="flex items-center gap-2 text-gray-500">
              <AlertCircle size={16} />
              <span className="text-sm">Pending Replies</span>
            </div>
            <p className="mt-2 text-2xl font-bold text-orange-600">{stats.pending}</p>
          </div>
          <div
            className={cn(
              'rounded-xl border bg-white px-5 py-4 shadow-sm cursor-pointer hover:shadow-md transition-all',
              drillDown === 'ai_sent' ? 'border-teal-500 ring-2 ring-teal-100' : 'border-gray-200 hover:border-teal-300'
            )}
            onClick={() => handleKpiClick('ai_sent')}
          >
            <div className="flex items-center gap-2 text-gray-500">
              <Brain size={16} />
              <span className="text-sm">AI Send Rate</span>
            </div>
            <p className="mt-2 text-2xl font-bold text-teal-700">{stats.aiSendRate}%</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
            <div className="flex items-center gap-2 text-gray-500">
              <Clock size={16} />
              <span className="text-sm">Avg Processing</span>
            </div>
            <p className="mt-2 text-2xl font-bold text-gray-900">{stats.avgProcessingTime}m</p>
          </div>
          <div
            className={cn(
              'rounded-xl border bg-white px-5 py-4 shadow-sm cursor-pointer hover:shadow-md transition-all',
              drillDown === 'spam' ? 'border-red-500 ring-2 ring-red-100' : 'border-gray-200 hover:border-red-300'
            )}
            onClick={() => handleKpiClick('spam')}
          >
            <div className="flex items-center gap-2 text-gray-500">
              <ShieldAlert size={16} />
              <span className="text-sm">Spam</span>
            </div>
            <p className={cn('mt-2 text-2xl font-bold', stats.spam > 0 ? 'text-red-600' : 'text-gray-400')}>{stats.spam}</p>
          </div>
        </div>
      )}

      {/* Drill-down message list */}
      {drillDown && (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900">
              {drillDownTitle[drillDown]} ({drillDownMessages.length}{drillDownMessages.length >= 50 ? '+' : ''})
            </h3>
            <button
              onClick={() => { setDrillDown(null); setDrillDownMessages([]) }}
              className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
          {drillDownLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex gap-3 animate-pulse">
                  <div className="h-8 w-8 rounded-full bg-gray-200 shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-40 bg-gray-200 rounded" />
                    <div className="h-3 w-64 bg-gray-200 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : drillDownMessages.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No messages found for this filter.</p>
          ) : (
            <div className="divide-y divide-gray-100 max-h-[400px] overflow-y-auto">
              {drillDownMessages.map((msg) => (
                <Link
                  key={msg.id}
                  href={msg.conversation_id ? `/conversations/${msg.conversation_id}` : '#'}
                  className="flex items-start gap-3 py-3 hover:bg-gray-50 -mx-6 px-6 transition-colors"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 shrink-0 mt-0.5">
                    <Mail size={14} className="text-gray-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {msg.sender_name || 'Unknown sender'}
                      </span>
                      <span className="text-xs text-gray-400 shrink-0 whitespace-nowrap">
                        {timeAgo(msg.received_at)}
                      </span>
                    </div>
                    {msg.email_subject && (
                      <p className="text-xs font-medium text-gray-600 truncate">{msg.email_subject}</p>
                    )}
                    <p className="text-xs text-gray-400 truncate mt-0.5">
                      {msg.message_text?.slice(0, 100) || 'No content'}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      {msg.replied && <Badge variant="success" size="sm">Replied</Badge>}
                      {msg.is_spam && <Badge variant="danger" size="sm">Spam</Badge>}
                      {!msg.replied && !msg.is_spam && <Badge variant="warning" size="sm">Pending</Badge>}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Two columns: classification + conversations */}
      {loading ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm lg:col-span-1 animate-pulse">
            <div className="h-5 w-40 bg-gray-200 rounded mb-4" />
            <div className="mx-auto h-40 w-40 rounded-full bg-gray-200" />
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm lg:col-span-2 animate-pulse">
            <div className="h-5 w-48 bg-gray-200 rounded mb-4" />
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="flex gap-3">
                  <div className="h-9 w-9 rounded-full bg-gray-200" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-32 bg-gray-200 rounded" />
                    <div className="h-3 w-64 bg-gray-200 rounded" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Classification breakdown */}
          <Card title="Classification Breakdown" className="lg:col-span-1">
            <div className="space-y-3">
              {categories.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8">
                  <div className="mx-auto h-40 w-40 rounded-full bg-gray-100 flex items-center justify-center">
                    <span className="text-xs font-semibold text-gray-400">0 msgs</span>
                  </div>
                  <p className="mt-4 text-sm text-gray-400">No classifications yet</p>
                </div>
              ) : (
                <>
                  {/* Simple CSS pie chart representation */}
                  <div className="mx-auto h-40 w-40 rounded-full overflow-hidden relative"
                    style={{
                      background: `conic-gradient(${categories.map((c, i) => {
                        const startPct = categories.slice(0, i).reduce((s, x) => s + x.pct, 0)
                        const color = categoryColors[c.category] || 'bg-gray-400'
                        const cssColor = cssColorMap[color] || '#9ca3af'
                        return `${cssColor} ${startPct}% ${startPct + c.pct}%`
                      }).join(', ')})`
                    }}
                  >
                    <div className="absolute inset-4 rounded-full bg-white flex items-center justify-center">
                      <span className="text-xs font-semibold text-gray-600">
                        {categories.reduce((s, c) => s + c.count, 0)} msgs
                      </span>
                    </div>
                  </div>

                  {/* Legend */}
                  <div className="space-y-2 mt-4">
                    {categories.slice(0, 6).map(c => (
                      <div key={c.category} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-block h-3 w-3 rounded-full"
                            style={{
                              backgroundColor: cssColorMap[categoryColors[c.category] || 'bg-gray-400']
                            }}
                          />
                          <span className="text-gray-700">{c.category}</span>
                        </div>
                        <span className="text-gray-500">{c.pct}%</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </Card>

          {/* Recent conversations */}
          <Card title="Recent Conversations" className="lg:col-span-2">
            {conversations.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-400">
                No conversations yet for this account.
              </p>
            ) : (
              <div className="divide-y divide-gray-100">
                {conversations.map(conv => {
                  const senderInitial = (conv.participantName || '?').replace(/["<]/g, '').trim().charAt(0).toUpperCase()
                  const colors = ['bg-blue-500','bg-teal-500','bg-purple-500','bg-orange-500','bg-pink-500','bg-indigo-500','bg-emerald-500','bg-amber-500']
                  const avatarColor = colors[(conv.participantName || '').length % colors.length]
                  const cleanName = (conv.participantName || 'Unknown').replace(/<[^>]+>/g, '').replace(/"/g, '').trim()
                  const shortName = cleanName.length > 35 ? cleanName.substring(0, 35) + '...' : cleanName

                  return (
                    <Link
                      key={conv.id}
                      href={`/conversations/${conv.id}`}
                      className="flex items-start gap-3 py-4 hover:bg-gray-50 -mx-6 px-6 transition-colors rounded-lg"
                    >
                      <div className={`${avatarColor} h-9 w-9 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0 mt-0.5`}>
                        {senderInitial}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-semibold text-gray-900 text-sm truncate">
                              {shortName}
                            </span>
                            <Badge
                              variant={conv.status === 'active' ? 'warning' : 'success'}
                              size="sm"
                            >
                              {conv.status}
                            </Badge>
                          </div>
                          <span className="shrink-0 text-xs text-gray-400 whitespace-nowrap">{timeAgo(conv.timestamp)}</span>
                        </div>
                        <p className="mt-1 text-sm text-gray-500 truncate leading-snug">{conv.preview}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <Badge size="sm">{conv.category}</Badge>
                          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', getSentimentColor(conv.sentiment))}>
                            {conv.sentiment}
                          </span>
                          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', getUrgencyColor(conv.urgency))}>
                            {conv.urgency}
                          </span>
                        </div>
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
