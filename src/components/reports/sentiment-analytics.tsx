'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ReportCard } from '@/components/reports/report-card'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase-client'
import { cn, timeAgo } from '@/lib/utils'
import {
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  Smile,
  Frown,
  Meh,
  Loader2,
  MessageCircle,
  Users,
  ArrowRight,
  X,
} from 'lucide-react'

// Message type with conversation link support
interface SentimentMessage {
  sentiment: string
  preview: string
  senderName?: string
  conversationId?: string
  channel?: string
}

// Reusable floating sentiment table modal — with sentiment filter tabs and clickable rows
function SentimentTableModal({ title, messages, onClose, initialFilter }: {
  title: string
  messages: SentimentMessage[]
  onClose: () => void
  initialFilter?: 'all' | 'positive' | 'neutral' | 'negative'
}) {
  const [filter, setFilter] = useState<'all' | 'positive' | 'neutral' | 'negative'>(initialFilter || 'all')
  const filtered = filter === 'all' ? messages : messages.filter(m => m.sentiment === filter)
  const posCount = messages.filter(m => m.sentiment === 'positive').length
  const neuCount = messages.filter(m => m.sentiment === 'neutral').length
  const negCount = messages.filter(m => m.sentiment === 'negative').length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 w-[650px] max-w-[95vw] max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-gray-50">
          <h3 className="text-sm font-bold text-gray-800">{title}</h3>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-gray-200 text-gray-400 hover:text-gray-700 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* Sentiment filter tabs */}
        <div className="flex items-center gap-1 px-5 py-2 border-b border-gray-100 bg-white">
          {([
            { key: 'all' as const, label: 'All', count: messages.length, color: 'bg-gray-600' },
            { key: 'positive' as const, label: 'Positive', count: posCount, color: 'bg-green-500' },
            { key: 'neutral' as const, label: 'Neutral', count: neuCount, color: 'bg-gray-400' },
            { key: 'negative' as const, label: 'Negative', count: negCount, color: 'bg-red-500' },
          ]).map(tab => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                filter === tab.key
                  ? 'bg-gray-800 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
            >
              <span className={cn('h-2 w-2 rounded-full', filter === tab.key ? 'bg-white' : tab.color)} />
              {tab.label} ({tab.count})
            </button>
          ))}
        </div>
        <div className="overflow-y-auto max-h-[55vh]">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase w-24">Sentiment</th>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase">Sender</th>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 && (
                <tr><td colSpan={3} className="px-5 py-8 text-center text-xs text-gray-400">No messages match this filter</td></tr>
              )}
              {filtered.map((m, i) => {
                const row = (
                  <tr key={i} className={cn(
                    'transition-colors cursor-pointer',
                    m.sentiment === 'positive' ? 'hover:bg-green-50' : m.sentiment === 'negative' ? 'hover:bg-red-50' : 'hover:bg-gray-50'
                  )}>
                    <td className="px-5 py-3">
                      <span className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
                        m.sentiment === 'positive' ? 'bg-green-100 text-green-700' :
                        m.sentiment === 'negative' ? 'bg-red-100 text-red-700' :
                        'bg-gray-100 text-gray-600'
                      )}>
                        <span className={cn('h-2 w-2 rounded-full',
                          m.sentiment === 'positive' ? 'bg-green-500' : m.sentiment === 'negative' ? 'bg-red-500' : 'bg-gray-400'
                        )} />
                        {m.sentiment === 'positive' ? 'Pos' : m.sentiment === 'negative' ? 'Neg' : 'Neu'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs font-medium text-gray-800 truncate max-w-[120px]">{m.senderName || 'Unknown'}</td>
                    <td className="px-5 py-3 text-xs text-gray-600 leading-relaxed">
                      <span className="line-clamp-2">{m.preview || 'No message text'}</span>
                      {m.conversationId && (
                        <span className="text-[10px] text-teal-600 ml-1">→ View conversation</span>
                      )}
                    </td>
                  </tr>
                )
                return m.conversationId ? (
                  <Link key={i} href={`/conversations/${m.conversationId}`} className="contents">
                    {row}
                  </Link>
                ) : row
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 bg-gray-50 text-xs text-gray-500">
          <span>{filtered.length} of {messages.length} messages</span>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-500" /> {posCount}</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-gray-400" /> {neuCount}</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" /> {negCount}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface CompanySentiment {
  accountName: string
  accountId: string
  total: number
  positive: number
  neutral: number
  negative: number
  score: number // -100 to +100
  trend: 'improving' | 'stable' | 'declining'
  atRiskConversations: number
  messages: SentimentMessage[]
}

interface SentimentByDay {
  date: string
  positive: number
  neutral: number
  negative: number
}

interface AtRiskConversation {
  conversationId: string
  participantName: string
  accountName: string
  channel: string
  negativeCount: number
  lastNegativeAt: string
}

interface CategorySentiment {
  category: string
  positive: number
  neutral: number
  negative: number
  total: number
  messages: SentimentMessage[]
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function SentimentStatCard({ label, value, subtitle, icon: Icon, color, bgColor }: {
  label: string; value: string | number; subtitle?: string; icon: React.ElementType; color: string; bgColor: string
}) {
  return (
    <div className={cn('rounded-xl border p-4 shadow-sm', bgColor)}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-gray-500">{label}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
          {subtitle && <p className="mt-0.5 text-xs text-gray-400">{subtitle}</p>}
        </div>
        <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', color)}>
          <Icon className="h-4 w-4 text-white" />
        </div>
      </div>
    </div>
  )
}

// ─── Sentiment Score Bar ──────────────────────────────────────────────────────

function SentimentScoreBar({ score }: { score: number }) {
  // Score from -100 to +100, map to 0-100 for bar position
  const position = Math.max(0, Math.min(100, (score + 100) / 2))
  return (
    <div className="relative">
      <div className="h-3 rounded-full bg-gradient-to-r from-red-400 via-gray-300 to-green-400 overflow-hidden" />
      <div
        className="absolute top-1/2 -translate-y-1/2 h-5 w-5 rounded-full bg-white border-2 border-gray-800 shadow-md transition-all"
        style={{ left: `calc(${position}% - 10px)` }}
      />
      <div className="flex justify-between text-[10px] text-gray-400 mt-1">
        <span>Negative</span>
        <span>Neutral</span>
        <span>Positive</span>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface ChannelSentiment {
  channel: string
  positive: number
  neutral: number
  negative: number
  total: number
  score: number
  messages: SentimentMessage[]
}

export function SentimentAnalyticsTab({ dateStart }: { dateStart: string }) {
  const [loading, setLoading] = useState(true)
  const [modalData, setModalData] = useState<{ title: string; messages: SentimentMessage[]; initialFilter?: 'all' | 'positive' | 'neutral' | 'negative' } | null>(null)
  const [channelFilter, setChannelFilter] = useState<'all' | 'email' | 'teams' | 'whatsapp'>('all')
  const [overallScore, setOverallScore] = useState(0)
  const [totals, setTotals] = useState({ positive: 0, neutral: 0, negative: 0, total: 0 })
  const [channelSentiments, setChannelSentiments] = useState<ChannelSentiment[]>([])
  const [companies, setCompanies] = useState<CompanySentiment[]>([])
  const [dailyTrend, setDailyTrend] = useState<SentimentByDay[]>([])
  const [atRisk, setAtRisk] = useState<AtRiskConversation[]>([])
  const [categories, setCategories] = useState<CategorySentiment[]>([])
  const [allMessages, setAllMessages] = useState<SentimentMessage[]>([])

  useEffect(() => {
    async function fetchData() {
      setLoading(true)
      const supabase = createClient()

      // Fetch ALL classifications with account info
      const { data: classData } = await supabase
        .from('message_classifications')
        .select(`
          sentiment,
          category,
          classified_at,
          messages!inner (
            message_text,
            account_id,
            conversation_id,
            sender_name,
            is_spam,
            channel,
            accounts!messages_account_id_fkey ( name )
          )
        `)
        .gte('classified_at', dateStart)
        .limit(10000)

      const classifications = (classData || []).filter((c: any) => !c.messages?.is_spam)

      // --- Overall totals ---
      let pos = 0, neu = 0, neg = 0
      classifications.forEach((c: any) => {
        if (c.sentiment === 'positive') pos++
        else if (c.sentiment === 'negative') neg++
        else neu++
      })
      const total = pos + neu + neg
      setTotals({ positive: pos, neutral: neu, negative: neg, total })
      setOverallScore(total > 0 ? Math.round(((pos - neg) / total) * 100) : 0)
      setAllMessages(classifications.map((c: any) => ({
        sentiment: c.sentiment,
        senderName: (c.messages?.sender_name || '').replace(/<[^>]+>/g, '').replace(/^["']+|["']+$/g, '').trim() || 'Customer',
        preview: (c.messages?.message_text || '').substring(0, 150),
        conversationId: c.messages?.conversation_id || undefined,
        channel: c.messages?.channel || 'email',
      })))

      // --- Channel-wise breakdown ---
      const chMap: Record<string, { pos: number; neu: number; neg: number; total: number; messages: SentimentMessage[] }> = {}
      classifications.forEach((c: any) => {
        const ch = c.messages?.channel || 'email'
        if (!chMap[ch]) chMap[ch] = { pos: 0, neu: 0, neg: 0, total: 0, messages: [] }
        chMap[ch].total++
        if (c.sentiment === 'positive') chMap[ch].pos++
        else if (c.sentiment === 'negative') chMap[ch].neg++
        else chMap[ch].neu++
        chMap[ch].messages.push({
          sentiment: c.sentiment,
          senderName: (c.messages?.sender_name || '').replace(/<[^>]+>/g, '').replace(/^["']+|["']+$/g, '').trim() || 'Customer',
          preview: (c.messages?.message_text || '').substring(0, 150),
          conversationId: c.messages?.conversation_id || undefined,
          channel: ch,
        })
      })
      setChannelSentiments(['email', 'teams', 'whatsapp'].map(ch => {
        const d = chMap[ch] || { pos: 0, neu: 0, neg: 0, total: 0, messages: [] }
        return {
          channel: ch,
          positive: d.pos,
          neutral: d.neu,
          negative: d.neg,
          total: d.total,
          score: d.total > 0 ? Math.round(((d.pos - d.neg) / d.total) * 100) : 0,
          messages: d.messages,
        }
      }))

      // --- Company-wise breakdown ---
      const companyMap: Record<string, { accountId: string; pos: number; neu: number; neg: number; total: number; recentSentiments: { sentiment: string; time: string }[]; messages: SentimentMessage[] }> = {}
      const convNegCount: Record<string, { count: number; participantName: string; accountName: string; channel: string; lastNeg: string }> = {}

      classifications.forEach((c: any) => {
        const accName = (c.messages?.accounts?.name || 'Unknown').replace(/\s+Teams$/i, '')
        const accId = c.messages?.account_id || ''
        const convId = c.messages?.conversation_id || ''

        if (!companyMap[accName]) {
          companyMap[accName] = { accountId: accId, pos: 0, neu: 0, neg: 0, total: 0, recentSentiments: [], messages: [] }
        }
        const co = companyMap[accName]
        co.total++
        if (c.sentiment === 'positive') co.pos++
        else if (c.sentiment === 'negative') co.neg++
        else co.neu++
        co.recentSentiments.push({ sentiment: c.sentiment, time: c.classified_at })
        co.messages.push({
          sentiment: c.sentiment,
          senderName: (c.messages?.sender_name || '').replace(/<[^>]+>/g, '').replace(/^["']+|["']+$/g, '').trim() || 'Customer',
          preview: (c.messages?.message_text || '').substring(0, 150),
          conversationId: convId || undefined,
          channel: c.messages?.channel || 'email',
        })

        // Track at-risk conversations (2+ negative messages)
        if (c.sentiment === 'negative' && convId) {
          if (!convNegCount[convId]) {
            convNegCount[convId] = {
              count: 0,
              participantName: c.messages?.sender_name || 'Unknown',
              accountName: accName,
              channel: c.messages?.channel || 'email',
              lastNeg: c.classified_at,
            }
          }
          convNegCount[convId].count++
          if (c.classified_at > convNegCount[convId].lastNeg) {
            convNegCount[convId].lastNeg = c.classified_at
          }
        }
      })

      // Build company sentiment array
      const companyArr: CompanySentiment[] = Object.entries(companyMap).map(([name, data]) => {
        const score = data.total > 0 ? Math.round(((data.pos - data.neg) / data.total) * 100) : 0
        // Calculate trend from recent vs earlier sentiments
        const sorted = data.recentSentiments.sort((a, b) => a.time.localeCompare(b.time))
        const values: number[] = sorted.map(s => s.sentiment === 'positive' ? 1 : s.sentiment === 'negative' ? -1 : 0)
        const recent = values.slice(-3)
        const earlier = values.slice(0, Math.max(1, values.length - 3))
        const recentAvg = recent.length > 0 ? recent.reduce((a: number, b: number) => a + b, 0) / recent.length : 0
        const earlierAvg = earlier.length > 0 ? earlier.reduce((a: number, b: number) => a + b, 0) / earlier.length : 0
        const diff = recentAvg - earlierAvg
        const trend: 'improving' | 'stable' | 'declining' = diff > 0.3 ? 'improving' : diff < -0.3 ? 'declining' : 'stable'
        const atRiskCount = Object.values(convNegCount).filter(c => c.accountName === name && c.count >= 2).length

        return {
          accountName: name,
          accountId: data.accountId,
          total: data.total,
          positive: data.pos,
          neutral: data.neu,
          negative: data.neg,
          score,
          trend,
          atRiskConversations: atRiskCount,
          messages: data.messages || [],
        }
      }).sort((a, b) => a.score - b.score) // Worst first

      setCompanies(companyArr)

      // --- At-risk conversations (2+ negative messages) ---
      const atRiskArr: AtRiskConversation[] = Object.entries(convNegCount)
        .filter(([, data]) => data.count >= 2)
        .map(([convId, data]) => ({
          conversationId: convId,
          participantName: data.participantName?.replace(/<[^>]+>/g, '').replace(/^["']+|["']+$/g, '').trim() || 'Unknown',
          accountName: data.accountName,
          channel: data.channel,
          negativeCount: data.count,
          lastNegativeAt: data.lastNeg,
        }))
        .sort((a, b) => b.negativeCount - a.negativeCount)
        .slice(0, 15)

      setAtRisk(atRiskArr)

      // --- Daily sentiment trend ---
      const dayMap: Record<string, { positive: number; neutral: number; negative: number }> = {}
      classifications.forEach((c: any) => {
        const day = (c.classified_at || '').substring(0, 10)
        if (!day) return
        if (!dayMap[day]) dayMap[day] = { positive: 0, neutral: 0, negative: 0 }
        if (c.sentiment === 'positive') dayMap[day].positive++
        else if (c.sentiment === 'negative') dayMap[day].negative++
        else dayMap[day].neutral++
      })

      const days: string[] = []
      for (let i = 29; i >= 0; i--) {
        days.push(new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().substring(0, 10))
      }
      setDailyTrend(days.map(d => ({
        date: d,
        positive: dayMap[d]?.positive || 0,
        neutral: dayMap[d]?.neutral || 0,
        negative: dayMap[d]?.negative || 0,
      })))

      // --- Sentiment by category ---
      const catMap: Record<string, { positive: number; neutral: number; negative: number; total: number; messages: SentimentMessage[] }> = {}
      classifications.forEach((c: any) => {
        const cat = c.category || 'Unknown'
        if (!catMap[cat]) catMap[cat] = { positive: 0, neutral: 0, negative: 0, total: 0, messages: [] }
        catMap[cat].total++
        if (c.sentiment === 'positive') catMap[cat].positive++
        else if (c.sentiment === 'negative') catMap[cat].negative++
        else catMap[cat].neutral++
        catMap[cat].messages.push({
          sentiment: c.sentiment,
          senderName: (c.messages?.sender_name || '').replace(/<[^>]+>/g, '').replace(/^["']+|["']+$/g, '').trim() || 'Customer',
          preview: (c.messages?.message_text || '').substring(0, 150),
          conversationId: c.messages?.conversation_id || undefined,
          channel: c.messages?.channel || 'email',
        })
      })
      setCategories(
        Object.entries(catMap)
          .map(([category, data]) => ({ category, ...data, messages: data.messages }))
          .sort((a, b) => (b.negative / b.total) - (a.negative / a.total))
      )

      setLoading(false)
    }
    fetchData()
  }, [dateStart])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Channel Filter Tabs */}
      <div className="flex items-center gap-2 rounded-lg bg-gray-100 p-1">
        {[
          { value: 'all' as const, label: 'All Channels' },
          { value: 'email' as const, label: 'Email' },
          { value: 'teams' as const, label: 'Teams' },
          { value: 'whatsapp' as const, label: 'WhatsApp' },
        ].map(tab => (
          <button
            key={tab.value}
            onClick={() => setChannelFilter(tab.value)}
            className={cn(
              'px-4 py-1.5 rounded-md text-sm font-medium transition-colors',
              channelFilter === tab.value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Per-Channel Sentiment Cards */}
      {channelFilter === 'all' ? (
        <>
          {/* Overall KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SentimentStatCard label="Overall Score" value={`${overallScore > 0 ? '+' : ''}${overallScore}`} subtitle="Scale: -100 to +100" icon={overallScore >= 0 ? Smile : Frown} color={overallScore >= 20 ? 'bg-green-500' : overallScore >= -20 ? 'bg-gray-500' : 'bg-red-500'} bgColor="border-gray-200 bg-white" />
            <SentimentStatCard label="Positive" value={totals.positive} subtitle={`${totals.total > 0 ? Math.round((totals.positive / totals.total) * 100) : 0}% of total`} icon={Smile} color="bg-green-500" bgColor="border-green-100 bg-green-50" />
            <SentimentStatCard label="Neutral" value={totals.neutral} subtitle={`${totals.total > 0 ? Math.round((totals.neutral / totals.total) * 100) : 0}% of total`} icon={Meh} color="bg-gray-500" bgColor="border-gray-100 bg-gray-50" />
            <SentimentStatCard label="Negative" value={totals.negative} subtitle={`${totals.total > 0 ? Math.round((totals.negative / totals.total) * 100) : 0}% of total`} icon={Frown} color="bg-red-500" bgColor="border-red-100 bg-red-50" />
          </div>

          {/* Channel comparison cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {channelSentiments.map(ch => (
              <button
                key={ch.channel}
                onClick={() => ch.total > 0 ? setModalData({ title: `${ch.channel.charAt(0).toUpperCase() + ch.channel.slice(1)} — Sentiment Details`, messages: ch.messages }) : null}
                className={cn('rounded-xl border border-gray-200 bg-white p-4 text-left transition-all', ch.total > 0 && 'hover:border-teal-300 hover:shadow-sm cursor-pointer')}
              >
                <p className="text-sm font-semibold text-gray-800 capitalize mb-2">{ch.channel}</p>
                <p className={cn('text-2xl font-bold', ch.score >= 20 ? 'text-green-600' : ch.score >= -20 ? 'text-gray-700' : 'text-red-600')}>
                  {ch.total > 0 ? `${ch.score > 0 ? '+' : ''}${ch.score}` : '--'}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{ch.total} messages</p>
                {ch.total > 0 && (
                  <>
                    <div className="flex items-center gap-1 h-2 rounded-full overflow-hidden bg-gray-100 mt-2">
                      {ch.positive > 0 && <div className="h-full bg-green-500" style={{ width: `${(ch.positive / ch.total) * 100}%` }} />}
                      {ch.neutral > 0 && <div className="h-full bg-gray-300" style={{ width: `${(ch.neutral / ch.total) * 100}%` }} />}
                      {ch.negative > 0 && <div className="h-full bg-red-400" style={{ width: `${(ch.negative / ch.total) * 100}%` }} />}
                    </div>
                    <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                      <span>{ch.positive} pos</span>
                      <span>{ch.neutral} neu</span>
                      <span>{ch.negative} neg</span>
                    </div>
                    <p className="text-[10px] text-teal-600 text-center mt-1">Click for details</p>
                  </>
                )}
              </button>
            ))}
          </div>
        </>
      ) : (
        /* Filtered to single channel */
        (() => {
          const ch = channelSentiments.find(c => c.channel === channelFilter) || { channel: channelFilter, positive: 0, neutral: 0, negative: 0, total: 0, score: 0, messages: [] }
          return (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SentimentStatCard label={`${channelFilter.charAt(0).toUpperCase() + channelFilter.slice(1)} Score`} value={ch.total > 0 ? `${ch.score > 0 ? '+' : ''}${ch.score}` : '--'} subtitle={`${ch.total} messages`} icon={ch.score >= 0 ? Smile : Frown} color={ch.score >= 20 ? 'bg-green-500' : ch.score >= -20 ? 'bg-gray-500' : 'bg-red-500'} bgColor="border-gray-200 bg-white" />
              <SentimentStatCard label="Positive" value={ch.positive} subtitle={`${ch.total > 0 ? Math.round((ch.positive / ch.total) * 100) : 0}%`} icon={Smile} color="bg-green-500" bgColor="border-green-100 bg-green-50" />
              <SentimentStatCard label="Neutral" value={ch.neutral} subtitle={`${ch.total > 0 ? Math.round((ch.neutral / ch.total) * 100) : 0}%`} icon={Meh} color="bg-gray-500" bgColor="border-gray-100 bg-gray-50" />
              <SentimentStatCard label="Negative" value={ch.negative} subtitle={`${ch.total > 0 ? Math.round((ch.negative / ch.total) * 100) : 0}%`} icon={Frown} color="bg-red-500" bgColor="border-red-100 bg-red-50" />
            </div>
          )
        })()
      )}

      {/* Overall Sentiment Score Bar — clickable */}
      <ReportCard title="Overall Sentiment Score" description={`Based on ${totals.total} classified messages — click to see details`}>
        <button className="w-full text-left hover:opacity-90 transition-opacity" onClick={() => setModalData({ title: 'All Messages — Sentiment Details', messages: allMessages })}>
          <SentimentScoreBar score={overallScore} />
          <p className="text-[10px] text-teal-600 text-center mt-2">Click to view all messages</p>
        </button>
      </ReportCard>

      {/* Daily Sentiment Trend */}
      <ReportCard title="Daily Sentiment Trend (30 Days)" description="How customer sentiment changes over time">
        <div className="space-y-1">
          <div className="flex items-end gap-0.5" style={{ height: 150 }}>
            {dailyTrend.map((d, i) => {
              const total = d.positive + d.neutral + d.negative
              const maxTotal = Math.max(...dailyTrend.map(x => x.positive + x.neutral + x.negative), 1)
              const pct = Math.max((total / maxTotal) * 100, 2)
              const posPct = total > 0 ? (d.positive / total) * 100 : 0
              const negPct = total > 0 ? (d.negative / total) * 100 : 0
              return (
                <div key={i} className="flex-1 flex flex-col group relative" style={{ height: `${pct}%` }}>
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 hidden group-hover:block bg-gray-800 text-white text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap z-10">
                    +{d.positive} / {d.neutral} / -{d.negative}
                  </div>
                  <div className="bg-red-400 rounded-t" style={{ height: `${negPct}%`, minHeight: d.negative > 0 ? 2 : 0 }} />
                  <div className="bg-gray-300 flex-1" />
                  <div className="bg-green-500 rounded-b" style={{ height: `${posPct}%`, minHeight: d.positive > 0 ? 2 : 0 }} />
                </div>
              )
            })}
          </div>
          <div className="flex justify-between text-[10px] text-gray-400 px-0.5">
            <span>{dailyTrend[0]?.date?.slice(5)}</span>
            <span>{dailyTrend[14]?.date?.slice(5)}</span>
            <span>{dailyTrend[29]?.date?.slice(5)}</span>
          </div>
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-green-500" /> Positive</span>
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-gray-300" /> Neutral</span>
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-red-400" /> Negative</span>
          </div>
        </div>
      </ReportCard>

      {/* Company-wise Sentiment Breakdown */}
      <ReportCard title={`Sentiment by Company${channelFilter !== 'all' ? ` (${channelFilter})` : ''}`} description="Sorted by worst score first — companies needing attention at the top">
        <div className="space-y-3">
          {companies.map((co) => {
            // Filter messages by selected channel
            const filteredMsgs = channelFilter === 'all' ? co.messages : co.messages.filter(m => m.channel === channelFilter)
            if (filteredMsgs.length === 0) return null
            const fPos = filteredMsgs.filter(m => m.sentiment === 'positive').length
            const fNeu = filteredMsgs.filter(m => m.sentiment === 'neutral').length
            const fNeg = filteredMsgs.filter(m => m.sentiment === 'negative').length
            const fTotal = filteredMsgs.length
            const fScore = fTotal > 0 ? Math.round(((fPos - fNeg) / fTotal) * 100) : 0
            return (
            <div key={co.accountName} className="rounded-xl border border-gray-200 p-4 hover:border-teal-300 hover:shadow-sm transition-all cursor-pointer" onClick={() => setModalData({ title: `${co.accountName}${channelFilter !== 'all' ? ` (${channelFilter})` : ''} — Sentiment Details`, messages: filteredMsgs })}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-gray-800">{co.accountName}</span>
                  <span className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                    co.trend === 'declining' ? 'bg-red-50 text-red-700' : co.trend === 'improving' ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-600'
                  )}>
                    {co.trend === 'declining' ? <TrendingDown className="h-3 w-3" /> : co.trend === 'improving' ? <TrendingUp className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
                    {co.trend}
                  </span>
                  {co.atRiskConversations > 0 && (
                    <Badge variant="danger" size="sm">
                      <AlertTriangle className="h-3 w-3 mr-0.5" />
                      {co.atRiskConversations} at risk
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn('text-lg font-bold', fScore >= 20 ? 'text-green-600' : fScore >= -20 ? 'text-gray-600' : 'text-red-600')}>
                    {fScore > 0 ? '+' : ''}{fScore}
                  </span>
                  <span className="text-xs text-gray-400">/ 100</span>
                </div>
              </div>

              {/* Sentiment bar */}
              <div className="flex items-center gap-1 h-4 rounded-full overflow-hidden bg-gray-100">
                {fPos > 0 && <div className="h-full bg-green-500 transition-all rounded-l-full" style={{ width: `${(fPos / fTotal) * 100}%` }} />}
                {fNeu > 0 && <div className="h-full bg-gray-300 transition-all" style={{ width: `${(fNeu / fTotal) * 100}%` }} />}
                {fNeg > 0 && <div className="h-full bg-red-400 transition-all rounded-r-full" style={{ width: `${(fNeg / fTotal) * 100}%` }} />}
              </div>
              <div className="flex justify-between text-[10px] text-gray-500 mt-1">
                <span>{fPos} positive ({fTotal > 0 ? Math.round((fPos / fTotal) * 100) : 0}%)</span>
                <span>{fNeu} neutral</span>
                <span>{fNeg} negative ({fTotal > 0 ? Math.round((fNeg / fTotal) * 100) : 0}%)</span>
              </div>
              <p className="text-[10px] text-teal-600 text-center mt-1">Click to view messages</p>
            </div>
            )
          })}
          {companies.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-6">No sentiment data available for this period.</p>
          )}
        </div>
      </ReportCard>

      {/* Sentiment by Category */}
      <ReportCard title="Sentiment by Category" description="Click any category to view messages — click sentiment bar sections to filter">
        <div className="space-y-2">
          {categories.map((cat) => {
            const negPct = cat.total > 0 ? Math.round((cat.negative / cat.total) * 100) : 0
            return (
              <div key={cat.category} className="flex items-center gap-3 rounded-lg px-2 py-1.5 -mx-2 hover:bg-gray-50 cursor-pointer transition-colors"
                onClick={() => setModalData({ title: `${cat.category} — Sentiment Details`, messages: cat.messages })}>
                <span className="text-sm text-gray-700 w-40 truncate shrink-0 font-medium">{cat.category}</span>
                <div className="flex-1 flex items-center gap-0.5 h-5 rounded overflow-hidden bg-gray-100">
                  {cat.positive > 0 && (
                    <div className="h-full bg-green-500 hover:bg-green-600 transition-colors"
                      style={{ width: `${(cat.positive / cat.total) * 100}%` }}
                      title={`${cat.positive} positive — click to filter`}
                      onClick={(e) => { e.stopPropagation(); setModalData({ title: `${cat.category} — Positive Messages`, messages: cat.messages, initialFilter: 'positive' }) }}
                    />
                  )}
                  {cat.neutral > 0 && (
                    <div className="h-full bg-gray-300 hover:bg-gray-400 transition-colors"
                      style={{ width: `${(cat.neutral / cat.total) * 100}%` }}
                      title={`${cat.neutral} neutral — click to filter`}
                      onClick={(e) => { e.stopPropagation(); setModalData({ title: `${cat.category} — Neutral Messages`, messages: cat.messages, initialFilter: 'neutral' }) }}
                    />
                  )}
                  {cat.negative > 0 && (
                    <div className="h-full bg-red-400 hover:bg-red-500 transition-colors"
                      style={{ width: `${(cat.negative / cat.total) * 100}%` }}
                      title={`${cat.negative} negative — click to filter`}
                      onClick={(e) => { e.stopPropagation(); setModalData({ title: `${cat.category} — Negative Messages`, messages: cat.messages, initialFilter: 'negative' }) }}
                    />
                  )}
                </div>
                <span className={cn('text-xs font-semibold w-10 text-right', negPct >= 30 ? 'text-red-600' : 'text-gray-500')}>
                  {negPct}%
                </span>
                <ArrowRight className="h-3 w-3 text-gray-300 shrink-0" />
              </div>
            )
          })}
        </div>
      </ReportCard>

      {/* At-Risk Conversations */}
      {atRisk.length > 0 && (
        <ReportCard title={`At-Risk Conversations (${atRisk.length})`} description="Conversations with 2+ negative sentiment messages — need immediate attention">
          <div className="divide-y divide-gray-100">
            {atRisk.map((conv) => (
              <Link
                key={conv.conversationId}
                href={`/conversations/${conv.conversationId}`}
                className="flex items-center gap-3 py-3 px-2 -mx-2 rounded-lg hover:bg-red-50 transition-colors group"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-100 text-red-600 shrink-0">
                  <Frown className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 group-hover:text-red-700 truncate">{conv.participantName}</p>
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span>{conv.accountName}</span>
                    <span>&middot;</span>
                    <Badge variant={conv.channel === 'teams' ? 'info' : 'default'} size="sm">{conv.channel}</Badge>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold text-red-600">{conv.negativeCount} negative</p>
                  <p className="text-xs text-gray-400">{timeAgo(conv.lastNegativeAt)}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-gray-300 group-hover:text-red-500 shrink-0" />
              </Link>
            ))}
          </div>
        </ReportCard>
      )}

      {/* Response Impact */}
      <ReportCard title="Response Impact" description="How companies are trending — improving, stable, or declining">
        <div className="grid grid-cols-3 gap-4">
          {(() => {
            const improving = companies.filter(c => c.trend === 'improving').length
            const stable = companies.filter(c => c.trend === 'stable').length
            const declining = companies.filter(c => c.trend === 'declining').length
            return (
              <>
                <div className="rounded-xl border border-green-100 bg-green-50 p-4 text-center">
                  <TrendingUp className="h-8 w-8 mx-auto text-green-500 mb-2" />
                  <p className="text-2xl font-bold text-green-700">{improving}</p>
                  <p className="text-xs text-green-600 mt-1">Improving</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-center">
                  <Minus className="h-8 w-8 mx-auto text-gray-400 mb-2" />
                  <p className="text-2xl font-bold text-gray-700">{stable}</p>
                  <p className="text-xs text-gray-500 mt-1">Stable</p>
                </div>
                <div className="rounded-xl border border-red-100 bg-red-50 p-4 text-center">
                  <TrendingDown className="h-8 w-8 mx-auto text-red-500 mb-2" />
                  <p className="text-2xl font-bold text-red-700">{declining}</p>
                  <p className="text-xs text-red-600 mt-1">Declining</p>
                </div>
              </>
            )
          })()}
        </div>
      </ReportCard>

      {/* Key Insights — actionable alerts */}
      <ReportCard title="Key Insights" description="Actionable takeaways from sentiment analysis">
        <div className="space-y-3">
          {totals.negative > 0 && totals.total > 0 && (
            <div className="flex items-start gap-3 rounded-lg bg-red-50 border border-red-200 p-3">
              <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-red-800">
                  {Math.round((totals.negative / totals.total) * 100)}% of messages have negative sentiment
                </p>
                <p className="text-xs text-red-600 mt-0.5">
                  {totals.negative} out of {totals.total} classified messages. {atRisk.length > 0 ? `${atRisk.length} conversations are at risk.` : ''}
                </p>
              </div>
            </div>
          )}
          {companies.filter(c => c.trend === 'declining').length > 0 && (
            <div className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-200 p-3">
              <TrendingDown className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-800">
                  {companies.filter(c => c.trend === 'declining').length} companies have declining sentiment
                </p>
                <p className="text-xs text-amber-600 mt-0.5">
                  {companies.filter(c => c.trend === 'declining').map(c => c.accountName).join(', ')} — review recent interactions.
                </p>
              </div>
            </div>
          )}
          {categories.filter(c => c.total > 5 && (c.negative / c.total) > 0.3).length > 0 && (
            <div className="flex items-start gap-3 rounded-lg bg-blue-50 border border-blue-200 p-3">
              <MessageCircle className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-blue-800">High-friction categories detected</p>
                <p className="text-xs text-blue-600 mt-0.5">
                  {categories.filter(c => c.total > 5 && (c.negative / c.total) > 0.3).map(c => `${c.category} (${Math.round((c.negative / c.total) * 100)}% negative)`).join(', ')}
                </p>
              </div>
            </div>
          )}
          {totals.positive > totals.negative && (
            <div className="flex items-start gap-3 rounded-lg bg-green-50 border border-green-200 p-3">
              <Smile className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-green-800">Overall sentiment is positive</p>
                <p className="text-xs text-green-600 mt-0.5">
                  {Math.round((totals.positive / totals.total) * 100)}% positive — customers are generally satisfied.
                </p>
              </div>
            </div>
          )}
          {totals.total === 0 && (
            <p className="text-sm text-gray-400 text-center py-4">No sentiment data available for this period.</p>
          )}
        </div>
      </ReportCard>

      {/* Floating table modal */}
      {modalData && (
        <SentimentTableModal
          title={modalData.title}
          messages={modalData.messages}
          onClose={() => setModalData(null)}
          initialFilter={modalData.initialFilter}
        />
      )}
    </div>
  )
}
