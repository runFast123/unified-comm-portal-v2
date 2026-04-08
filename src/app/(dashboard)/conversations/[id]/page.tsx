import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { ConversationThread } from '@/components/dashboard/conversation-thread'
import { ScrollToBottom } from '@/components/dashboard/scroll-to-bottom'
import { MarkRead } from '@/components/dashboard/mark-read'
import { ConversationRealtime } from '@/components/dashboard/conversation-realtime'
import { AISidebar } from '@/components/dashboard/ai-sidebar'
import { ConversationActions } from '@/components/dashboard/conversation-actions'
import { SuggestedReplies } from '@/components/dashboard/suggested-replies'
import { BookmarkButton } from '@/components/dashboard/conversation-bookmarks'
import { StatusDropdown } from '@/components/dashboard/status-dropdown'
import { AgentAssignment } from '@/components/dashboard/agent-assignment'
import { InternalNotes } from '@/components/dashboard/internal-notes'
import {
  cn,
  getChannelLabel,
  getPriorityColor,
} from '@/lib/utils'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import type {
  ChannelType,
  Priority,
  ConversationStatus,
} from '@/types/database'

/** Derive priority from the conversation's priority field or fallback to 'medium' */
function derivePriority(p: string | null | undefined): Priority {
  if (p === 'urgent' || p === 'high' || p === 'medium' || p === 'low') return p
  return 'medium'
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()

  // Check user's role and account_id for scoping
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  let userAccountId: string | null = null
  let userIsAdmin = false
  if (authUser) {
    const { data: profile } = await supabase
      .from('users')
      .select('role, account_id')
      .eq('id', authUser.id)
      .maybeSingle()
    userIsAdmin = profile?.role === 'admin'
    userAccountId = profile?.account_id ?? null
  }

  // Fetch conversation details
  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select(`
      id,
      account_id,
      channel,
      status,
      priority,
      assigned_to,
      participant_name,
      participant_email,
      participant_phone,
      teams_chat_id,
      tags,
      first_message_at,
      last_message_at,
      accounts!conversations_account_id_fkey ( id, name, phase1_enabled, phase2_enabled ),
      users!conversations_assigned_to_fkey ( id, full_name, email )
    `)
    .eq('id', id)
    .maybeSingle()

  if (convError || !conversation) {
    notFound()
  }

  // Non-admin users can only access conversations for their own company
  if (!userIsAdmin && userAccountId && conversation.account_id !== userAccountId) {
    notFound()
  }

  // Fetch all messages in this conversation
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', id)
    .order('timestamp', { ascending: true })

  // Fetch classifications for messages in this conversation
  const messageIds = (messages || []).map((m) => m.id)
  let classification = null
  let sentimentHistory: { sentiment: 'positive' | 'neutral' | 'negative'; timestamp: string; preview: string }[] = []
  if (messageIds.length > 0) {
    const { data: allClassifications } = await supabase
      .from('message_classifications')
      .select('*, messages!inner(message_text, timestamp)')
      .in('message_id', messageIds)
      .order('classified_at', { ascending: true })

    if (allClassifications && allClassifications.length > 0) {
      // Latest classification for the sidebar header
      classification = allClassifications[allClassifications.length - 1]
      // Build sentiment history from all classifications
      sentimentHistory = allClassifications.map((c: any) => ({
        sentiment: c.sentiment as 'positive' | 'neutral' | 'negative',
        timestamp: c.classified_at || c.messages?.timestamp || '',
        preview: c.messages?.message_text?.substring(0, 60) || '',
      }))
    }
  }

  // Fetch AI replies for this conversation
  let aiReply = null
  const { data: aiReplies } = await supabase
    .from('ai_replies')
    .select('*')
    .eq('conversation_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
  aiReply = aiReplies?.[0] ?? null

  // Fetch KB articles used for this AI reply
  let kbArticleTitles: string[] = []
  if (aiReply) {
    const { data: kbHits } = await supabase
      .from('kb_hits')
      .select('kb_articles!kb_hits_kb_article_id_fkey(title)')
      .eq('ai_reply_id', aiReply.id)
    kbArticleTitles = (kbHits || [])
      .map((h: any) => h.kb_articles?.title)
      .filter(Boolean)
  }

  // Map AI reply to expected format for sidebar
  const mappedAiReply = aiReply
    ? {
        ...aiReply,
        draft_text: aiReply.draft_text || aiReply.edited_text || aiReply.final_text || '',
        confidence_score: aiReply.confidence_score ?? null,
        kb_articles_used: kbArticleTitles,
        approved_by: aiReply.reviewed_by,
        approved_at: aiReply.reviewed_at,
        edited_text: aiReply.edited_text,
        rejection_reason: aiReply.edit_notes,
      }
    : null

  // Fetch other conversations from same participant for history
  const participantEmail = conversation.participant_email
  let customerHistory: { id: string; channel: string; preview: string; date: string }[] = []
  if (participantEmail) {
    const { data: pastConversations } = await supabase
      .from('conversations')
      .select('id, channel, first_message_at, last_message_at')
      .eq('participant_email', participantEmail)
      .neq('id', id)
      .order('last_message_at', { ascending: false })
      .limit(5)

    if (pastConversations && pastConversations.length > 0) {
      // Get first message of each for preview
      for (const pc of pastConversations) {
        const { data: firstMsg } = await supabase
          .from('messages')
          .select('email_subject, message_text')
          .eq('conversation_id', pc.id)
          .order('timestamp', { ascending: true })
          .limit(1)
          .maybeSingle()

        customerHistory.push({
          id: pc.id,
          channel: getChannelLabel(pc.channel as ChannelType),
          preview: firstMsg?.email_subject || (firstMsg?.message_text ? firstMsg.message_text.substring(0, 80) + '...' : 'No preview'),
          date: pc.last_message_at
            ? new Date(pc.last_message_at).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : 'Unknown',
        })
      }
    }
  }

  const account = conversation.accounts as any
  const assignedUserRaw = conversation.users as any
  const assignedUser = Array.isArray(assignedUserRaw) ? (assignedUserRaw[0] ?? null) : (assignedUserRaw ?? null) as { id: string; full_name: string | null; email: string } | null
  const channel = conversation.channel as ChannelType
  const priority = derivePriority(conversation.priority)
  const status = (conversation.status || 'active') as ConversationStatus
  const rawName = conversation.participant_name || conversation.participant_email || 'Unknown'
  const participantName = rawName.replace(/<[^>]+>/g, '').replace(/^["']+|["']+$/g, '').replace(/\s*\.\s*$/, '').replace(/\s+/g, ' ').trim() || 'Unknown'
  const accountName = account?.name || 'Unknown Account'
  // Get the email subject from the first inbound message
  const firstInboundMsg = (messages || []).find((m: any) => m.direction === 'inbound')
  const emailSubject = firstInboundMsg?.email_subject || null

  // Contact info: count total conversations for this participant
  let totalConversations = 1
  if (conversation.participant_email) {
    const { count } = await supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('participant_email', conversation.participant_email)
    totalConversations = count || 1
  }

  // Conversation timer
  const firstMsgAt = conversation.first_message_at as string | null
  const lastMsgAt = conversation.last_message_at as string | null
  const now = Date.now()
  const activeDurationMs = firstMsgAt ? now - new Date(firstMsgAt).getTime() : 0
  const lastReplyMs = lastMsgAt ? now - new Date(lastMsgAt).getTime() : 0
  const formatDuration = (ms: number) => {
    const mins = Math.floor(ms / 60000)
    if (mins < 60) return `${mins}m`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ${mins % 60}m`
    const days = Math.floor(hrs / 24)
    return `${days}d ${hrs % 24}h`
  }
  const messageCount = (messages || []).length
  const inboundCount = (messages || []).filter((m: any) => m.direction === 'inbound').length

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* Conversation header */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-4 sm:px-6 py-3">
        {/* Top row: back + name + actions */}
        <div className="flex items-center gap-3 sm:gap-4">
          <Link
            href="/inbox"
            className="text-gray-400 hover:text-teal-700 transition-colors shrink-0"
          >
            <ArrowLeft size={20} />
          </Link>
          <ChannelIcon channel={channel} size={20} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-semibold text-gray-900 text-base truncate max-w-[200px] sm:max-w-[300px]">{participantName}</h1>
              <BookmarkButton conversationId={id} participantName={participantName} accountName={accountName} />
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500 mt-0.5">
              <span>{accountName.replace(/\s+Teams$/i, '')}</span>
              <span className="text-gray-300">&middot;</span>
              <span>{getChannelLabel(channel)}</span>
              {channel === 'teams' && conversation.teams_chat_id && (
                <span className="inline-flex items-center gap-0.5 rounded bg-indigo-50 px-1.5 py-0 text-[10px] font-medium text-indigo-600">
                  {conversation.teams_chat_id.includes('uni01_') ? '1:1' : 'Group'}
                </span>
              )}
              {conversation.participant_email && (
                <span className="hidden sm:inline text-gray-400">&middot; {conversation.participant_email}</span>
              )}
            </div>
          </div>
          {/* Status & priority badges */}
          <div className="flex items-center gap-2 shrink-0">
            <StatusDropdown
              conversationId={id}
              currentStatus={status}
            />
            <span className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              getPriorityColor(priority)
            )}>
              {priority}
            </span>
            <AgentAssignment
              conversationId={id}
              currentAssignedTo={conversation.assigned_to || null}
              currentAssignedName={assignedUser?.full_name || assignedUser?.email || null}
            />
          </div>
        </div>
        {/* Timer row */}
        <div className="flex items-center gap-3 text-[10px] text-gray-400 mt-1.5 ml-[52px] sm:ml-[60px] flex-wrap">
          {firstMsgAt && <span>Active {formatDuration(activeDurationMs)}</span>}
          {lastMsgAt && <span>&middot; Last reply {formatDuration(lastReplyMs)} ago</span>}
          <span>&middot; {messageCount} msgs ({inboundCount} inbound)</span>
          {totalConversations > 1 && (
            <span>&middot; {totalConversations} conversations</span>
          )}
        </div>
      </div>

      <MarkRead conversationId={id} />
      <ConversationRealtime conversationId={id} />

      {/* Follow-up reminder for conversations waiting >48h */}
      {status === 'waiting_on_customer' && lastMsgAt && lastReplyMs > 48 * 60 * 60 * 1000 && (
        <div className="shrink-0 mx-4 sm:mx-6 mt-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-2.5 flex items-center gap-3">
          <span className="text-amber-500 text-lg">⏰</span>
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-800">Customer hasn&apos;t replied in {formatDuration(lastReplyMs)}</p>
            <p className="text-xs text-amber-600">Consider sending a follow-up to keep the conversation active.</p>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 flex-col lg:flex-row overflow-hidden">
        {/* Message thread */}
        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex-1 overflow-y-auto px-4 sm:px-6">
            {messages && messages.length > 0 ? (
              <>
              <ConversationThread messages={messages} channel={channel} />
              <ScrollToBottom messageCount={messages.length} />
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                No messages in this conversation yet.
              </div>
            )}
          </div>

          {/* Suggested replies */}
          <SuggestedReplies
            conversationId={id}
            latestMessage={(messages || []).filter((m: any) => m.direction === 'inbound').pop()?.message_text || null}
            category={classification?.category || null}
          />

          {/* Bottom action bar */}
          <div className="shrink-0 border-t border-gray-200 bg-white px-4 sm:px-6 py-3">
            <ConversationActions
              conversationId={id}
              accountId={conversation.account_id}
              accountName={accountName}
              channel={channel}
              aiReplyId={aiReply?.id || null}
              aiReplyStatus={aiReply?.status || null}
              aiDraftText={aiReply?.draft_text || aiReply?.edited_text || null}
              participantEmail={conversation.participant_email}
              emailSubject={emailSubject}
              teamsChatId={conversation.teams_chat_id || null}
            />
          </div>
        </div>

        {/* Right sidebar - below thread on mobile, side panel on desktop */}
        <div className="w-full lg:w-80 shrink-0 overflow-y-auto border-t lg:border-t-0 lg:border-l border-gray-200 bg-gray-50 p-4 space-y-4">
          <AISidebar
            classification={classification}
            aiReply={mappedAiReply}
            kbArticles={kbArticleTitles}
            sentimentHistory={sentimentHistory}
            customerHistory={customerHistory}
          />
          <InternalNotes conversationId={id} />
        </div>
      </div>
    </div>
  )
}
