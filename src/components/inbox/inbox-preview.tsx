'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ExternalLink,
  Loader2,
  Brain,
  Sparkles,
  Mail,
  MessageSquare,
  Phone,
  Clock,
  Building2,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle,
  Reply,
  ArrowUpRight,
  Send,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase-client'
import { useToast } from '@/components/ui/toast'
import type { InboxItem, Message, ChannelType } from '@/types/database'

interface InboxPreviewProps {
  item: InboxItem
}

interface ConversationData {
  messages: Message[]
  classification: {
    category: string
    sentiment: string
    urgency: string
    confidence: number
    topic_summary: string | null
  } | null
  aiDraft: {
    id: string
    draft_text: string
    status: string
    confidence_score: number | null
  } | null
  participantName: string | null
  participantEmail: string | null
  accountName: string | null
  teamsChatId: string | null
  emailSubject: string | null
  fullMessageText: string | null
}

function getChannelIcon(channel: ChannelType) {
  switch (channel) {
    case 'email':
      return <Mail className="h-4 w-4 text-red-500" />
    case 'teams':
      return <MessageSquare className="h-4 w-4 text-purple-500" />
    case 'whatsapp':
      return <Phone className="h-4 w-4 text-green-500" />
  }
}

function SentimentIcon({ sentiment }: { sentiment: string }) {
  switch (sentiment) {
    case 'positive':
      return <TrendingUp size={12} className="text-green-600" />
    case 'negative':
      return <TrendingDown size={12} className="text-red-600" />
    default:
      return <Minus size={12} className="text-gray-500" />
  }
}

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function parseSender(sender: string | null): string {
  if (!sender) return 'Unknown'
  const cleaned = sender.replace(/<[^>]+>/g, '').replace(/^["']+|["']+$/g, '').trim()
  return cleaned || 'Unknown'
}

function getSentimentColor(sentiment: string): string {
  switch (sentiment) {
    case 'positive':
      return 'text-green-600'
    case 'negative':
      return 'text-red-600'
    default:
      return 'text-gray-600'
  }
}

function getUrgencyBadgeVariant(urgency: string): 'danger' | 'warning' | 'info' | 'default' {
  switch (urgency) {
    case 'urgent':
      return 'danger'
    case 'high':
      return 'warning'
    case 'medium':
      return 'info'
    default:
      return 'default'
  }
}

export function InboxPreview({ item }: InboxPreviewProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [data, setData] = useState<ConversationData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [quickReplyText, setQuickReplyText] = useState('')

  useEffect(() => {
    let cancelled = false

    async function fetchConversation() {
      setLoading(true)
      setError(null)

      try {
        const supabase = createClient()

        // Fetch messages, classification, AI reply, and conversation details in parallel
        const [messagesResult, classResult, aiReplyResult, convResult] = await Promise.all([
          supabase
            .from('messages')
            .select('*')
            .eq('conversation_id', item.conversation_id)
            .order('timestamp', { ascending: true }),
          supabase
            .from('message_classifications')
            .select('category, sentiment, urgency, confidence, topic_summary')
            .eq('message_id', item.message_id)
            .order('classified_at', { ascending: false })
            .limit(1),
          supabase
            .from('ai_replies')
            .select('id, draft_text, status, confidence_score')
            .eq('conversation_id', item.conversation_id)
            .order('created_at', { ascending: false })
            .limit(1),
          supabase
            .from('conversations')
            .select('participant_name, participant_email, teams_chat_id, accounts!conversations_account_id_fkey ( name )')
            .eq('id', item.conversation_id)
            .single(),
        ])

        if (cancelled) return
        if (convResult.error) console.warn('Failed to fetch conversation:', convResult.error.message)

        const account = (convResult.data as any)?.accounts as { name: string } | null

        // Get the selected message's full text (not truncated)
        const selectedMessage = (messagesResult.data || []).find(
          (m: any) => m.id === item.message_id
        )
        // Get email subject from first inbound message
        const firstInbound = (messagesResult.data || []).find(
          (m: any) => m.direction === 'inbound'
        )

        setData({
          messages: messagesResult.data || [],
          classification: classResult.data?.[0] || null,
          aiDraft: aiReplyResult.data?.[0] || null,
          participantName: convResult.data?.participant_name || null,
          participantEmail: convResult.data?.participant_email || null,
          accountName: account?.name || null,
          teamsChatId: convResult.data?.teams_chat_id || null,
          emailSubject: firstInbound?.email_subject || selectedMessage?.email_subject || null,
          fullMessageText: selectedMessage?.message_text || null,
        })
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Failed to load conversation')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchConversation()
    return () => {
      cancelled = true
    }
  }, [item.conversation_id, item.message_id])

  const handleApprove = useCallback(async () => {
    if (!data?.aiDraft?.id) return
    setActionLoading('approve')
    try {
      const supabase = createClient()
      const { error: err } = await supabase
        .from('ai_replies')
        .update({ status: 'approved', reviewed_at: new Date().toISOString() })
        .eq('id', data.aiDraft.id)
      if (err) throw err
      toast.success('AI draft approved!')
      // Refresh data
      setData((prev) =>
        prev && prev.aiDraft
          ? { ...prev, aiDraft: { ...prev.aiDraft, status: 'approved' } }
          : prev
      )
    } catch (err: any) {
      toast.error('Failed to approve: ' + err.message)
    } finally {
      setActionLoading(null)
    }
  }, [data, toast])

  const handleQuickReply = useCallback(async () => {
    if (!quickReplyText.trim()) return
    setActionLoading('quick-reply')
    try {
      const actionMap: Record<string, string> = { email: 'send_email_reply', teams: 'send_teams_reply', whatsapp: 'send_whatsapp_reply' }
      const supabase = createClient()

      // Get conversation details for teams_chat_id
      const { data: conv } = await supabase
        .from('conversations')
        .select('teams_chat_id, participant_email')
        .eq('id', item.conversation_id)
        .maybeSingle()

      const res = await fetch('/api/n8n', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: actionMap[item.channel] || 'send_email_reply',
          account_id: item.account_id,
          data: {
            to: conv?.participant_email || '',
            subject: item.subject_or_preview ? `Re: ${item.subject_or_preview.substring(0, 100)}` : 'Re: Your inquiry',
            body: quickReplyText,
            reply_text: quickReplyText,
            conversation_id: item.conversation_id,
            teams_chat_id: conv?.teams_chat_id || undefined,
          },
        }),
      })

      if (res.ok) {
        // Create outbound message record
        await supabase.from('messages').insert({
          conversation_id: item.conversation_id,
          account_id: item.account_id,
          channel: item.channel,
          sender_name: item.account_name || 'Agent',
          sender_type: 'agent',
          message_text: quickReplyText,
          direction: 'outbound',
          replied: true,
          reply_required: false,
          timestamp: new Date().toISOString(),
          received_at: new Date().toISOString(),
        })
        // Mark inbound as replied
        await supabase
          .from('messages')
          .update({ replied: true })
          .eq('conversation_id', item.conversation_id)
          .eq('direction', 'inbound')
          .eq('replied', false)
        // Update conversation status
        await supabase
          .from('conversations')
          .update({ status: 'waiting_on_customer' })
          .eq('id', item.conversation_id)

        toast.success('Reply sent!')
        setQuickReplyText('')
      } else {
        toast.error('Failed to send reply')
      }
    } catch (err: any) {
      toast.error('Error: ' + err.message)
    } finally {
      setActionLoading(null)
    }
  }, [quickReplyText, item, toast])

  const handleEscalate = useCallback(async () => {
    setActionLoading('escalate')
    try {
      const supabase = createClient()
      const { error: err } = await supabase
        .from('conversations')
        .update({ status: 'escalated', priority: 'urgent' })
        .eq('id', item.conversation_id)
      if (err) throw err
      toast.success('Conversation escalated!')
    } catch (err: any) {
      toast.error('Failed to escalate: ' + err.message)
    } finally {
      setActionLoading(null)
    }
  }, [item.conversation_id, toast])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-teal-600" />
          <p className="text-sm text-gray-500">Loading conversation...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="text-center">
          <p className="text-sm font-medium text-red-700">Failed to load</p>
          <p className="mt-1 text-xs text-red-500">{error}</p>
        </div>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="flex h-full flex-col">
      {/* Preview Header - Sender & Account Info */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            {getChannelIcon(item.channel)}
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-gray-900 truncate">
                {parseSender(item.sender_name)}
              </h3>
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                {data.participantEmail && (
                  <span className="truncate">{data.participantEmail}</span>
                )}
                {data.accountName && (
                  <>
                    <span>&middot;</span>
                    <span className="inline-flex items-center gap-1 shrink-0">
                      <Building2 size={10} />
                      {(data.accountName || '').replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '')}
                    </span>
                  </>
                )}
                {item.channel === 'teams' && (
                  <span className="inline-flex shrink-0 rounded bg-indigo-50 px-1.5 py-0 text-[10px] font-semibold text-indigo-600 border border-indigo-100">
                    Teams {data.teamsChatId?.includes('uni01_') ? '1:1' : 'Group'}
                  </span>
                )}
              </div>
            </div>
          </div>
          <Link
            href={`/conversations/${item.conversation_id}`}
            className="inline-flex items-center gap-1 rounded-lg bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-700 hover:bg-teal-100 transition-colors shrink-0"
          >
            <ExternalLink size={12} />
            Open Full View
          </Link>
        </div>

        {/* Email Subject */}
        {data.emailSubject && (
          <p className="mt-2 text-sm font-medium text-gray-800">
            {data.emailSubject}
          </p>
        )}

        {/* Timestamp */}
        <p className="mt-1 text-xs text-gray-400 flex items-center gap-1">
          <Clock size={10} />
          {formatDate(item.timestamp)}
        </p>
      </div>

      {/* AI Classification Section */}
      {data.classification && (
        <div className="shrink-0 border-b border-gray-200 bg-gray-50 px-4 py-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Brain size={14} className="text-teal-600" />
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">AI Classification</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md bg-white border border-gray-100 px-2.5 py-1.5">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider">Category</p>
              <p className="text-xs font-medium text-gray-800">{data.classification.category}</p>
            </div>
            <div className="rounded-md bg-white border border-gray-100 px-2.5 py-1.5">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider">Sentiment</p>
              <p className={`text-xs font-medium inline-flex items-center gap-1 ${getSentimentColor(data.classification.sentiment)}`}>
                <SentimentIcon sentiment={data.classification.sentiment} />
                {data.classification.sentiment}
              </p>
            </div>
            <div className="rounded-md bg-white border border-gray-100 px-2.5 py-1.5">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider">Urgency</p>
              <Badge variant={getUrgencyBadgeVariant(data.classification.urgency)} size="sm">
                {data.classification.urgency}
              </Badge>
            </div>
            <div className="rounded-md bg-white border border-gray-100 px-2.5 py-1.5">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider">Confidence</p>
              <p className="text-xs font-medium text-gray-800">
                {Math.round(Number(data.classification.confidence) * 100)}%
              </p>
            </div>
          </div>
          {data.classification.topic_summary && (
            <p className="mt-2 text-xs text-gray-600 leading-relaxed">
              {data.classification.topic_summary}
            </p>
          )}
        </div>
      )}

      {/* AI Draft Section */}
      {data.aiDraft && (
        <div className="shrink-0 border-b border-gray-200 bg-purple-50 px-4 py-3">
          <div className="flex items-center gap-2 mb-1.5">
            <Sparkles size={12} className="text-purple-600" />
            <span className="text-xs font-medium text-purple-700">AI Draft Reply</span>
            <Badge
              variant={data.aiDraft.status === 'pending_approval' ? 'warning' : data.aiDraft.status === 'sent' || data.aiDraft.status === 'approved' ? 'success' : 'info'}
              size="sm"
            >
              {data.aiDraft.status === 'pending_approval' ? 'Pending Approval' : data.aiDraft.status}
            </Badge>
            {data.aiDraft.confidence_score != null && (
              <span className="text-xs text-purple-400 ml-auto">
                {Math.round(Number(data.aiDraft.confidence_score) * 100)}% conf.
              </span>
            )}
          </div>
          <p className="text-xs text-gray-700 leading-relaxed line-clamp-4">
            {data.aiDraft.draft_text}
          </p>
        </div>
      )}

      {/* Full Email Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {data.fullMessageText ? (
          <div className="prose prose-sm max-w-none">
            <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">
              {data.fullMessageText}
            </p>
          </div>
        ) : data.messages.length > 0 ? (
          <div className="space-y-3">
            {data.messages.map((msg) => {
              const isOutbound = msg.direction === 'outbound'
              return (
                <div
                  key={msg.id}
                  className={`max-w-[85%] ${isOutbound ? 'ml-auto' : 'mr-auto'}`}
                >
                  <div
                    className={`rounded-lg px-3 py-2 text-sm ${
                      isOutbound
                        ? 'bg-teal-50 border border-teal-200'
                        : 'bg-white border border-gray-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-medium text-gray-600 truncate">
                        {parseSender(msg.sender_name)}
                      </span>
                      <span className="text-[10px] text-gray-400 whitespace-nowrap flex items-center gap-1">
                        <Clock size={9} />
                        {formatDate(msg.timestamp)}
                      </span>
                    </div>
                    {msg.email_subject && (
                      <p className="text-xs font-medium text-gray-800 mb-1">
                        {msg.email_subject}
                      </p>
                    )}
                    <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">
                      {msg.message_text}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-gray-400">
            No messages in this conversation.
          </div>
        )}
      </div>

      {/* Quick Action Buttons */}
      {/* Quick Reply */}
      <div className="shrink-0 border-t border-gray-200 bg-white px-4 py-2.5 space-y-2">
        <div className="flex items-end gap-2">
          <textarea
            value={quickReplyText}
            onChange={(e) => setQuickReplyText(e.target.value)}
            placeholder="Type a quick reply..."
            rows={2}
            className="flex-1 text-sm rounded-lg border border-gray-200 px-3 py-2 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none resize-none"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={!quickReplyText.trim() || actionLoading === 'quick-reply'}
            onClick={handleQuickReply}
          >
            {actionLoading === 'quick-reply' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Send size={14} />
            )}
            Send
          </Button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {data.aiDraft && data.aiDraft.status === 'pending_approval' && (
            <Button
              variant="success"
              size="sm"
              onClick={handleApprove}
              disabled={actionLoading === 'approve'}
            >
              {actionLoading === 'approve' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <CheckCircle size={14} />
              )}
              Approve AI Draft
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="bg-orange-50 text-orange-700 hover:bg-orange-100 border border-orange-200"
            onClick={handleEscalate}
            disabled={actionLoading === 'escalate'}
          >
            {actionLoading === 'escalate' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <ArrowUpRight size={14} />
            )}
            Escalate
          </Button>
          <div className="flex-1" />
          <Link href={`/conversations/${item.conversation_id}`}>
            <Button variant="secondary" size="sm">
              <ExternalLink size={14} />
              Full View
            </Button>
          </Link>
        </div>
      </div>
    </div>
  )
}
