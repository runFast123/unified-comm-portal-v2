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
} from 'lucide-react'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { PhaseIndicator } from '@/components/ui/phase-indicator'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import {
  cn,
  timeAgo,
  getChannelLabel,
  getSentimentColor,
  getUrgencyColor,
} from '@/lib/utils'
import type { Category, Sentiment, Urgency, ConversationStatus } from '@/types/database'

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

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()

  // Fetch the account
  const { data: account } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <h2 className="text-xl font-semibold text-gray-900">Account not found</h2>
        <Link href="/accounts" className="mt-4 text-teal-700 hover:underline">
          Back to accounts
        </Link>
      </div>
    )
  }

  // Fetch total messages for this account
  const { count: totalMessages } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', id)

  // Fetch pending replies count
  const { count: pendingReplies } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', id)
    .eq('reply_required', true)
    .eq('replied', false)

  // Fetch AI reply stats for send rate computation
  const { data: aiReplies } = await supabase
    .from('ai_replies')
    .select('status, confidence_score')
    .eq('account_id', id)

  const totalAiReplies = (aiReplies || []).length
  // Only count 'sent' replies for send rate, not 'approved' (which hasn't been sent yet)
  const sentAiReplies = (aiReplies || []).filter(
    (r: { status: string }) => r.status === 'sent'
  ).length
  const aiSendRate = totalAiReplies > 0
    ? Math.round((sentAiReplies / totalAiReplies) * 100)
    : 0

  // Compute average confidence as a proxy if no sent/approved breakdown
  const avgConfidence = totalAiReplies > 0
    ? Math.round(
        (aiReplies || []).reduce((sum: number, r: { confidence_score: number }) => sum + (r.confidence_score || 0), 0) /
          totalAiReplies * 100
      )
    : 0

  const displaySendRate = totalAiReplies > 0 ? aiSendRate : 0

  // Avg AI processing time: difference between ai_reply sent_at and created_at
  // Note: this measures how long AI took to process, not customer response time
  const { data: responseTimes } = await supabase
    .from('ai_replies')
    .select('sent_at, created_at')
    .eq('account_id', id)
    .not('sent_at', 'is', null)

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

  // Fetch classification breakdown
  const { data: classificationRows } = await supabase
    .from('message_classifications')
    .select('category, message_id, messages!inner(account_id)')
    .eq('messages.account_id', id)

  // Build category counts
  const catMap = new Map<string, number>()
  ;(classificationRows || []).forEach((row: { category: string }) => {
    catMap.set(row.category, (catMap.get(row.category) || 0) + 1)
  })
  const classTotal = Array.from(catMap.values()).reduce((a, b) => a + b, 0)
  const categories = Array.from(catMap.entries())
    .map(([category, count]) => ({
      category: category as Category,
      count,
      pct: classTotal > 0 ? Math.round((count / classTotal) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count)

  // Fetch recent conversations with latest classification
  const { data: conversationRows } = await supabase
    .from('conversations')
    .select('id, participant_name, status, priority, last_message_at, created_at')
    .eq('account_id', id)
    .order('last_message_at', { ascending: false })
    .limit(6)

  // For each conversation, get the latest message + classification for preview
  const conversations = await Promise.all(
    (conversationRows || []).map(async (conv: {
      id: string
      participant_name: string | null
      status: string
      priority: string
      last_message_at: string | null
      created_at: string
    }) => {
      // Get latest message for preview
      const { data: latestMsg } = await supabase
        .from('messages')
        .select('message_text, timestamp')
        .eq('conversation_id', conv.id)
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle()

      // Get latest classification for this conversation's messages
      const { data: latestClassification } = await supabase
        .from('message_classifications')
        .select('category, sentiment, urgency')
        .in(
          'message_id',
          (await supabase
            .from('messages')
            .select('id')
            .eq('conversation_id', conv.id)
          ).data?.map((m: { id: string }) => m.id) || []
        )
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

  const stats = {
    total: totalMessages || 0,
    pending: pendingReplies || 0,
    aiSendRate: displaySendRate,
    avgProcessingTime,
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

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center gap-2 text-gray-500">
            <MessageCircle size={16} />
            <span className="text-sm">Total Messages</span>
          </div>
          <p className="mt-2 text-2xl font-bold text-gray-900">{stats.total}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center gap-2 text-gray-500">
            <AlertCircle size={16} />
            <span className="text-sm">Pending Replies</span>
          </div>
          <p className="mt-2 text-2xl font-bold text-orange-600">{stats.pending}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
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
      </div>

      {/* Two columns: classification + conversations */}
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
                // Extract clean sender name (before email part)
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
    </div>
  )
}
