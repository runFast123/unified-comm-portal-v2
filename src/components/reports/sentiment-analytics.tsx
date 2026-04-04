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
} from 'lucide-react'

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

export function SentimentAnalyticsTab({ dateStart }: { dateStart: string }) {
  const [loading, setLoading] = useState(true)
  const [overallScore, setOverallScore] = useState(0)
  const [totals, setTotals] = useState({ positive: 0, neutral: 0, negative: 0, total: 0 })
  const [companies, setCompanies] = useState<CompanySentiment[]>([])
  const [dailyTrend, setDailyTrend] = useState<SentimentByDay[]>([])
  const [atRisk, setAtRisk] = useState<AtRiskConversation[]>([])
  const [categories, setCategories] = useState<CategorySentiment[]>([])

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
            account_id,
            conversation_id,
            sender_name,
            is_spam,
            channel,
            accounts!messages_account_id_fkey ( name )
          )
        `)
        .gte('classified_at', dateStart)

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

      // --- Company-wise breakdown ---
      const companyMap: Record<string, { accountId: string; pos: number; neu: number; neg: number; total: number; recentSentiments: { sentiment: string; time: string }[] }> = {}
      const convNegCount: Record<string, { count: number; participantName: string; accountName: string; channel: string; lastNeg: string }> = {}

      classifications.forEach((c: any) => {
        const accName = (c.messages?.accounts?.name || 'Unknown').replace(/\s+Teams$/i, '')
        const accId = c.messages?.account_id || ''
        const convId = c.messages?.conversation_id || ''

        if (!companyMap[accName]) {
          companyMap[accName] = { accountId: accId, pos: 0, neu: 0, neg: 0, total: 0, recentSentiments: [] }
        }
        const co = companyMap[accName]
        co.total++
        if (c.sentiment === 'positive') co.pos++
        else if (c.sentiment === 'negative') co.neg++
        else co.neu++
        co.recentSentiments.push({ sentiment: c.sentiment, time: c.classified_at })

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
      const catMap: Record<string, { positive: number; neutral: number; negative: number; total: number }> = {}
      classifications.forEach((c: any) => {
        const cat = c.category || 'Unknown'
        if (!catMap[cat]) catMap[cat] = { positive: 0, neutral: 0, negative: 0, total: 0 }
        catMap[cat].total++
        if (c.sentiment === 'positive') catMap[cat].positive++
        else if (c.sentiment === 'negative') catMap[cat].negative++
        else catMap[cat].neutral++
      })
      setCategories(
        Object.entries(catMap)
          .map(([category, data]) => ({ category, ...data }))
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
      {/* Overall Sentiment KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SentimentStatCard label="Overall Score" value={`${overallScore > 0 ? '+' : ''}${overallScore}`} subtitle="Scale: -100 to +100" icon={overallScore >= 0 ? Smile : Frown} color={overallScore >= 20 ? 'bg-green-500' : overallScore >= -20 ? 'bg-gray-500' : 'bg-red-500'} bgColor="border-gray-200 bg-white" />
        <SentimentStatCard label="Positive" value={totals.positive} subtitle={`${totals.total > 0 ? Math.round((totals.positive / totals.total) * 100) : 0}% of total`} icon={Smile} color="bg-green-500" bgColor="border-green-100 bg-green-50" />
        <SentimentStatCard label="Neutral" value={totals.neutral} subtitle={`${totals.total > 0 ? Math.round((totals.neutral / totals.total) * 100) : 0}% of total`} icon={Meh} color="bg-gray-500" bgColor="border-gray-100 bg-gray-50" />
        <SentimentStatCard label="Negative" value={totals.negative} subtitle={`${totals.total > 0 ? Math.round((totals.negative / totals.total) * 100) : 0}% of total`} icon={Frown} color="bg-red-500" bgColor="border-red-100 bg-red-50" />
      </div>

      {/* Overall Sentiment Score Bar */}
      <ReportCard title="Overall Sentiment Score" description={`Based on ${totals.total} classified messages`}>
        <SentimentScoreBar score={overallScore} />
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
      <ReportCard title="Sentiment by Company" description="Sorted by worst score first — companies needing attention at the top">
        <div className="space-y-3">
          {companies.map((co) => (
            <div key={co.accountName} className="rounded-xl border border-gray-200 p-4 hover:border-gray-300 transition-colors">
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
                  <span className={cn('text-lg font-bold', co.score >= 20 ? 'text-green-600' : co.score >= -20 ? 'text-gray-600' : 'text-red-600')}>
                    {co.score > 0 ? '+' : ''}{co.score}
                  </span>
                  <span className="text-xs text-gray-400">/ 100</span>
                </div>
              </div>

              {/* Sentiment bar */}
              <div className="flex items-center gap-1 h-4 rounded-full overflow-hidden bg-gray-100">
                {co.positive > 0 && <div className="h-full bg-green-500 transition-all rounded-l-full" style={{ width: `${(co.positive / co.total) * 100}%` }} />}
                {co.neutral > 0 && <div className="h-full bg-gray-300 transition-all" style={{ width: `${(co.neutral / co.total) * 100}%` }} />}
                {co.negative > 0 && <div className="h-full bg-red-400 transition-all rounded-r-full" style={{ width: `${(co.negative / co.total) * 100}%` }} />}
              </div>
              <div className="flex justify-between text-[10px] text-gray-500 mt-1">
                <span>{co.positive} positive ({co.total > 0 ? Math.round((co.positive / co.total) * 100) : 0}%)</span>
                <span>{co.neutral} neutral</span>
                <span>{co.negative} negative ({co.total > 0 ? Math.round((co.negative / co.total) * 100) : 0}%)</span>
              </div>
            </div>
          ))}
          {companies.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-6">No sentiment data available for this period.</p>
          )}
        </div>
      </ReportCard>

      {/* Sentiment by Category */}
      <ReportCard title="Sentiment by Category" description="Which issue types generate the most negative customer reactions">
        <div className="space-y-2">
          {categories.map((cat) => {
            const negPct = cat.total > 0 ? Math.round((cat.negative / cat.total) * 100) : 0
            return (
              <div key={cat.category} className="flex items-center gap-3">
                <span className="text-sm text-gray-700 w-40 truncate shrink-0">{cat.category}</span>
                <div className="flex-1 flex items-center gap-1 h-5 rounded overflow-hidden bg-gray-100">
                  {cat.positive > 0 && <div className="h-full bg-green-500" style={{ width: `${(cat.positive / cat.total) * 100}%` }} />}
                  {cat.neutral > 0 && <div className="h-full bg-gray-300" style={{ width: `${(cat.neutral / cat.total) * 100}%` }} />}
                  {cat.negative > 0 && <div className="h-full bg-red-400" style={{ width: `${(cat.negative / cat.total) * 100}%` }} />}
                </div>
                <span className={cn('text-xs font-semibold w-10 text-right', negPct >= 30 ? 'text-red-600' : 'text-gray-500')}>
                  {negPct}% neg
                </span>
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
    </div>
  )
}
