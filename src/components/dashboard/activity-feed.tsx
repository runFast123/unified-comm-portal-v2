'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Mail, Tag, Bot, CheckCircle, RefreshCw, Loader2, Activity, ExternalLink } from 'lucide-react'
import { createClient } from '@/lib/supabase-client'

interface ActivityEvent {
  id: string
  type: 'new_message' | 'classified' | 'ai_draft' | 'reply_sent'
  description: string
  companyName: string
  timestamp: string
  icon: React.ReactNode
  conversationId: string | null
}

function formatActivityTime(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getEventIcon(type: ActivityEvent['type']): React.ReactNode {
  switch (type) {
    case 'new_message':
      return <Mail size={14} className="text-blue-500" />
    case 'classified':
      return <Tag size={14} className="text-purple-500" />
    case 'ai_draft':
      return <Bot size={14} className="text-teal-500" />
    case 'reply_sent':
      return <CheckCircle size={14} className="text-green-500" />
  }
}

function getEventBgColor(type: ActivityEvent['type']): string {
  switch (type) {
    case 'new_message':
      return 'bg-blue-50'
    case 'classified':
      return 'bg-purple-50'
    case 'ai_draft':
      return 'bg-teal-50'
    case 'reply_sent':
      return 'bg-green-50'
  }
}

function parseSenderName(raw: string | null): string {
  if (!raw) return 'Unknown'
  const cleaned = raw.replace(/<[^>]+>/g, '').replace(/^["']+|["']+$/g, '').trim()
  return cleaned || 'Unknown'
}

export function ActivityFeed() {
  const router = useRouter()
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchEvents = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }

    try {
      const supabase = createClient()
      const allEvents: ActivityEvent[] = []

      // Fetch recent messages (new_message + reply_sent)
      const { data: messages } = await supabase
        .from('messages')
        .select(`
          id,
          conversation_id,
          sender_name,
          direction,
          received_at,
          timestamp,
          accounts!messages_account_id_fkey ( name )
        `)
        .order('received_at', { ascending: false })
        .limit(20)

      if (messages) {
        for (const msg of messages) {
          const account = (msg as any).accounts as any
          const companyName = account?.name || 'Unknown'
          const sender = parseSenderName(msg.sender_name)

          if (msg.direction === 'inbound') {
            allEvents.push({
              id: `msg-${msg.id}`,
              type: 'new_message',
              description: `New email from ${sender}`,
              companyName,
              timestamp: msg.received_at || msg.timestamp,
              icon: getEventIcon('new_message'),
              conversationId: msg.conversation_id || null,
            })
          } else {
            allEvents.push({
              id: `reply-${msg.id}`,
              type: 'reply_sent',
              description: `Reply sent to ${sender}`,
              companyName,
              timestamp: msg.received_at || msg.timestamp,
              icon: getEventIcon('reply_sent'),
              conversationId: msg.conversation_id || null,
            })
          }
        }
      }

      // Fetch recent classifications
      const { data: classifications } = await supabase
        .from('message_classifications')
        .select(`
          id,
          category,
          sentiment,
          classified_at,
          messages!message_classifications_message_id_fkey (
            conversation_id,
            accounts!messages_account_id_fkey ( name )
          )
        `)
        .order('classified_at', { ascending: false })
        .limit(10)

      if (classifications) {
        for (const cls of classifications) {
          const msgData = (cls as any).messages as any
          const companyName = msgData?.accounts?.name || 'Unknown'
          allEvents.push({
            id: `cls-${cls.id}`,
            type: 'classified',
            description: `Classified as ${cls.category} (${cls.sentiment})`,
            companyName,
            timestamp: cls.classified_at,
            icon: getEventIcon('classified'),
            conversationId: msgData?.conversation_id || null,
          })
        }
      }

      // Fetch recent AI replies
      const { data: aiReplies } = await supabase
        .from('ai_replies')
        .select(`
          id,
          conversation_id,
          created_at,
          accounts!ai_replies_account_id_fkey ( name )
        `)
        .order('created_at', { ascending: false })
        .limit(10)

      if (aiReplies) {
        for (const reply of aiReplies) {
          const account = (reply as any).accounts as any
          const companyName = account?.name || 'Unknown'
          allEvents.push({
            id: `ai-${reply.id}`,
            type: 'ai_draft',
            description: `AI draft generated`,
            companyName,
            timestamp: reply.created_at,
            icon: getEventIcon('ai_draft'),
            conversationId: (reply as any).conversation_id || null,
          })
        }
      }

      // Sort all events by timestamp descending
      allEvents.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )

      // Take the latest 20
      setEvents(allEvents.slice(0, 20))
    } catch (err) {
      console.error('Failed to fetch activity events:', err)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    fetchEvents()
  }, [fetchEvents])

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchEvents(true)
    }, 30000)
    return () => clearInterval(interval)
  }, [fetchEvents])

  // Supabase realtime subscription for instant updates
  useEffect(() => {
    const supabase = createClient()

    const channel = supabase
      .channel('activity-feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        () => {
          fetchEvents(true)
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'message_classifications' },
        () => {
          fetchEvents(true)
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ai_replies' },
        () => {
          fetchEvents(true)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [fetchEvents])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-teal-600" />
        <span className="ml-2 text-sm text-gray-500">Loading activity...</span>
      </div>
    )
  }

  return (
    <div>
      {/* Header with refresh */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-teal-600" />
          <h3 className="text-sm font-semibold text-gray-700">Recent Activity</h3>
          {refreshing && (
            <Loader2 size={12} className="animate-spin text-gray-400" />
          )}
        </div>
        <button
          onClick={() => fetchEvents(true)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:text-teal-600 hover:bg-gray-100 transition-colors"
          disabled={refreshing}
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Events list — compact, max 8 visible with scroll */}
      {events.length === 0 ? (
        <div className="text-center py-4 text-sm text-gray-400">
          No recent activity
        </div>
      ) : (
        <div className="max-h-[320px] overflow-y-auto space-y-0.5 pr-1 scrollbar-thin">
          {events.slice(0, 15).map((event) => (
            <div
              key={event.id}
              onClick={() => {
                if (event.conversationId) {
                  router.push(`/conversations/${event.conversationId}`)
                }
              }}
              className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors ${
                event.conversationId
                  ? 'cursor-pointer hover:bg-gray-100 active:bg-gray-200'
                  : 'hover:bg-gray-50'
              }`}
              title={event.conversationId ? 'Click to view conversation' : undefined}
            >
              <div
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${getEventBgColor(
                  event.type
                )}`}
              >
                {event.icon}
              </div>
              <p className="flex-1 min-w-0 text-xs text-gray-700 truncate">
                {event.description}
              </p>
              <span className="shrink-0 text-[10px] text-gray-400 font-medium">{event.companyName}</span>
              <span className="shrink-0 text-[10px] text-gray-300 whitespace-nowrap">{formatActivityTime(event.timestamp)}</span>
              {event.conversationId && (
                <ExternalLink size={10} className="shrink-0 text-gray-300" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
