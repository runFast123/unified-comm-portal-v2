import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Crown, User } from 'lucide-react'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { ConversationThread } from '@/components/dashboard/conversation-thread'
import { ScrollToBottom } from '@/components/dashboard/scroll-to-bottom'
import { MarkRead } from '@/components/dashboard/mark-read'
import { ConversationRealtime } from '@/components/dashboard/conversation-realtime'
import { AISidebar } from '@/components/dashboard/ai-sidebar'
import { ConversationActions } from '@/components/dashboard/conversation-actions'
import { ScheduledMessagesList } from '@/components/dashboard/scheduled-messages-list'
import { SuggestedReplies } from '@/components/dashboard/suggested-replies'
import { BookmarkButton } from '@/components/dashboard/conversation-bookmarks'
import { StatusDropdown } from '@/components/dashboard/status-dropdown'
import { ConversationTagPicker } from '@/components/dashboard/conversation-tag-picker'
import { AgentAssignment } from '@/components/dashboard/agent-assignment'
import { InternalNotes } from '@/components/dashboard/internal-notes'
import { ActivityTimeline } from '@/components/dashboard/activity-timeline'
import { SnoozeButton } from '@/components/dashboard/snooze-button'
import { PresenceBar } from '@/components/dashboard/presence-bar'
import { MergeButton } from '@/components/dashboard/merge-button'
import { MergeBanner, type MergedSecondary } from '@/components/dashboard/merge-banner'
import { CSATSendButton } from '@/components/dashboard/csat-send-button'
import { TimeTrackingActive } from '@/components/dashboard/time-tracking-active'
import { ConversationTimeDisplay } from '@/components/dashboard/conversation-time-display'
import {
  cn,
  getChannelLabel,
  getPriorityColor,
} from '@/lib/utils'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isSuperAdmin } from '@/lib/auth'
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

  let userCompanyId: string | null = null
  let userIsSuperAdmin = false
  let currentUserName: string | null = null
  const currentUserId: string | null = authUser?.id ?? null
  if (authUser) {
    const { data: profile } = await supabase
      .from('users')
      .select('role, account_id, company_id, full_name')
      .eq('id', authUser.id)
      .maybeSingle()
    userIsSuperAdmin = isSuperAdmin(profile?.role)
    userCompanyId = profile?.company_id ?? null
    currentUserName = profile?.full_name ?? authUser.email ?? null
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
      secondary_status,
      secondary_status_color,
      first_message_at,
      last_message_at,
      contact_id,
      snoozed_until,
      snoozed_by,
      merged_into_id,
      merged_at,
      merged_by,
      accounts!conversations_account_id_fkey ( id, name, phase1_enabled, phase2_enabled ),
      users!conversations_assigned_to_fkey ( id, full_name, email )
    `)
    .eq('id', id)
    .maybeSingle()

  if (convError || !conversation) {
    notFound()
  }

  // Non-super-admin users can only access conversations for accounts in their
  // own company. Uses service role to bypass RLS — the page's RLS would already
  // hide the row, but we hit notFound() ourselves so the error matches a
  // missing conversation instead of a permission error.
  if (!userIsSuperAdmin && userCompanyId) {
    const adminSupabase = await createServiceRoleClient()
    const { data: companyAccounts } = await adminSupabase
      .from('accounts')
      .select('id')
      .eq('company_id', userCompanyId)
    const allowedIds = new Set((companyAccounts || []).map((a: { id: string }) => a.id))
    if (!allowedIds.has(conversation.account_id)) {
      notFound()
    }
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

  // ─── Unified contact profile chip ───────────────────────────────────
  // If this conversation has been linked to a contact (backfilled or set
  // by findOrCreateConversation on creation), surface a header chip and
  // a count of OTHER currently-open conversations across other accounts.
  let contactProfile: { id: string; is_vip: boolean } | null = null
  let otherOpenCount = 0
  const linkedContactId = (conversation as { contact_id?: string | null }).contact_id ?? null
  if (linkedContactId) {
    const { data: c } = await supabase
      .from('contacts')
      .select('id, is_vip')
      .eq('id', linkedContactId)
      .maybeSingle()
    contactProfile = (c ?? null) as { id: string; is_vip: boolean } | null

    if (contactProfile) {
      const { count } = await supabase
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', linkedContactId)
        .neq('id', id)
        .neq('account_id', conversation.account_id)
        .in('status', ['active', 'in_progress', 'escalated', 'waiting_on_customer'])
      otherOpenCount = count || 0
    }
  }

  // ─── Merged secondaries (this conversation as the primary) ──────────
  // Fetch any conversations that have been merged INTO this one so the header
  // can show a banner + an Unmerge action per row. Cheap query — bounded set.
  const mergedIntoId = (conversation as { merged_into_id?: string | null }).merged_into_id ?? null
  let mergedSecondaries: MergedSecondary[] = []
  if (!mergedIntoId) {
    const { data: secondaries } = await supabase
      .from('conversations')
      .select('id, channel, participant_name, participant_email, merged_at, merged_by')
      .eq('merged_into_id', id)
      .order('merged_at', { ascending: false })

    if (secondaries && secondaries.length > 0) {
      const secondaryIds = secondaries.map((s: { id: string }) => s.id)
      // Pull message counts (now ZERO for the secondaries since their messages
      // were re-pointed; we want the count that USED to live on each row, which
      // we capture from the audit table).
      const adminClient = await createServiceRoleClient()
      const { data: auditRows } = await adminClient
        .from('conversation_merges')
        .select('secondary_conversation_id, message_ids')
        .eq('primary_conversation_id', id)
        .is('unmerged_at', null)
      const movedCount = new Map<string, number>()
      for (const a of auditRows ?? []) {
        const row = a as { secondary_conversation_id: string; message_ids: string[] | null }
        movedCount.set(row.secondary_conversation_id, row.message_ids?.length ?? 0)
      }

      // Resolve the merger's display name in one round-trip.
      const userIds = Array.from(
        new Set(secondaries.map((s: { merged_by: string | null }) => s.merged_by).filter(Boolean) as string[])
      )
      const userNameById = new Map<string, string>()
      if (userIds.length > 0) {
        const { data: users } = await adminClient
          .from('users')
          .select('id, full_name, email')
          .in('id', userIds)
        for (const u of users ?? []) {
          const row = u as { id: string; full_name: string | null; email: string | null }
          userNameById.set(row.id, row.full_name || row.email || 'Unknown')
        }
      }

      mergedSecondaries = secondaries.map((s: any) => ({
        id: s.id,
        participant_name: s.participant_name ?? null,
        participant_email: s.participant_email ?? null,
        channel: s.channel,
        message_count: movedCount.get(s.id) ?? 0,
        merged_at: s.merged_at ?? null,
        merged_by_name: s.merged_by ? userNameById.get(s.merged_by) ?? null : null,
      }))
      // Suppress unused-var warning when secondaryIds isn't read elsewhere.
      void secondaryIds
    }
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

  // ─── CSAT eligibility — used to gate the "Send CSAT" button ────────
  // Pulls the conversation's account → company → csat_enabled flag.
  // Best-effort; failure leaves the button hidden (which is the safe default).
  let csatEnabled = false
  try {
    const adminForCsat = await createServiceRoleClient()
    const { data: csatAccount } = await adminForCsat
      .from('accounts')
      .select('company_id')
      .eq('id', conversation.account_id)
      .maybeSingle()
    const csatCompanyId = (csatAccount as { company_id: string | null } | null)?.company_id
    if (csatCompanyId) {
      const { data: csatCompany } = await adminForCsat
        .from('companies')
        .select('csat_enabled')
        .eq('id', csatCompanyId)
        .maybeSingle()
      csatEnabled = !!(csatCompany as { csat_enabled: boolean | null } | null)?.csat_enabled
    }
  } catch {
    /* keep csatEnabled=false on error */
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* Conversation header */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-4 sm:px-6 py-5">
        {/* Top row: back + name + actions */}
        <div className="flex items-center gap-4 sm:gap-5">
          <Link
            href="/inbox"
            className="text-gray-400 hover:text-teal-700 transition-colors shrink-0"
          >
            <ArrowLeft size={20} />
          </Link>
          <ChannelIcon channel={channel} size={22} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1
                // No max-w — the parent already has `min-w-0 flex-1` so
                // this h1 fills the available space and wraps naturally
                // within the line-clamp constraint. Earlier max-w-[360px]
                // truncated the title even on wide viewports.
                className="font-semibold text-gray-900 text-lg line-clamp-2 break-words"
                title={participantName}
              >
                {participantName}
              </h1>
              {contactProfile?.is_vip && (
                <span
                  title="Marked as VIP in unified contact profile"
                  className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
                >
                  <Crown className="h-2.5 w-2.5" />
                  VIP
                </span>
              )}
              <BookmarkButton conversationId={id} participantName={participantName} accountName={accountName} />
              {channel === 'teams' && conversation.teams_chat_id && (
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
                  {conversation.teams_chat_id.includes('uni01_') ? '1:1 Direct Message' : 'Group Chat'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-500 mt-1.5">
              <span>{accountName.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '')}</span>
              <span className="text-gray-300">&middot;</span>
              <span>{getChannelLabel(channel)}</span>
              {channel !== 'teams' && conversation.participant_email && (
                <span className="hidden sm:inline text-gray-400">&middot; {conversation.participant_email}</span>
              )}
            </div>
          </div>
          {/* Live "who else is here" stack — only renders when others are present */}
          {currentUserId && (
            <PresenceBar
              conversationId={id}
              currentUser={{
                user_id: currentUserId,
                display_name: currentUserName || 'You',
                avatar_url: null,
              }}
            />
          )}
          {/* Status & priority badges + action group.
              Visual dividers (h-6 w-px bg-gray-200) split the bar into three
              functional groups: status/priority | snooze/merge | assignment/csat
              so the header reads as separate concerns instead of one flat row.
              The pills carry `title` tooltips so hovering reveals what each
              represents (#4.3). */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2" title="Conversation status">
              <StatusDropdown
                conversationId={id}
                currentStatus={status}
                secondaryStatus={(conversation as { secondary_status?: string | null }).secondary_status ?? null}
                secondaryStatusColor={(conversation as { secondary_status_color?: string | null }).secondary_status_color ?? null}
              />
              <span
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap',
                  getPriorityColor(priority)
                )}
                title={`Priority: ${priority}`}
                aria-label={`Priority: ${priority}`}
              >
                {priority}
              </span>
            </div>
            <span className="h-6 w-px bg-gray-200" aria-hidden="true" />
            <div className="flex items-center gap-2">
              <SnoozeButton
                conversationId={id}
                snoozedUntil={(conversation as { snoozed_until?: string | null }).snoozed_until ?? null}
              />
              {!mergedIntoId && <MergeButton conversationId={id} />}
            </div>
            <span className="h-6 w-px bg-gray-200" aria-hidden="true" />
            <div className="flex items-center gap-2">
              <AgentAssignment
                conversationId={id}
                currentAssignedTo={conversation.assigned_to || null}
                currentAssignedName={assignedUser?.full_name || assignedUser?.email || null}
              />
              <CSATSendButton
                conversationId={id}
                csatEnabled={csatEnabled}
                status={status}
                hasParticipantEmail={!!conversation.participant_email}
              />
            </div>
          </div>
        </div>
        {/* Timer row */}
        <div className="flex items-center gap-4 text-[11px] text-gray-400 mt-3 ml-[52px] sm:ml-[62px] flex-wrap">
          {firstMsgAt && <span>Active {formatDuration(activeDurationMs)}</span>}
          {lastMsgAt && <span>&middot; Last reply {formatDuration(lastReplyMs)} ago</span>}
          <span>&middot; {messageCount} msgs ({inboundCount} inbound)</span>
          {totalConversations > 1 && (
            <span>&middot; {totalConversations} conversations</span>
          )}
          {contactProfile && (
            <>
              <span className="text-gray-300">&middot;</span>
              <Link
                href={`/contacts/${contactProfile.id}`}
                className="inline-flex items-center gap-1 rounded-full bg-teal-50 border border-teal-100 px-2 py-0.5 text-[10px] font-semibold text-teal-700 hover:bg-teal-100 transition-colors"
              >
                <User className="h-2.5 w-2.5" />
                View contact profile →
              </Link>
              {otherOpenCount > 0 && (
                <Link
                  href={`/contacts/${contactProfile.id}`}
                  className="text-teal-700 hover:underline"
                >
                  {otherOpenCount} other open
                </Link>
              )}
            </>
          )}
        </div>
      </div>

      <MarkRead conversationId={id} />
      <ConversationRealtime conversationId={id} />
      <TimeTrackingActive conversationId={id} />

      {/* Merge banner: either "this is a secondary, go to primary" OR
          "this primary has merged-in secondaries (with Unmerge buttons)" */}
      <MergeBanner
        mergedIntoId={mergedIntoId}
        mergedSecondaries={mergedSecondaries}
        primaryConversationId={id}
      />

      {/* Follow-up reminder for conversations waiting >48h */}
      {status === 'waiting_on_customer' && lastMsgAt && lastReplyMs > 48 * 60 * 60 * 1000 && (
        <div className="shrink-0 mx-4 sm:mx-6 mt-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 flex items-center gap-3">
          <span className="text-amber-500 text-lg">⏰</span>
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-800">Customer hasn&apos;t replied in {formatDuration(lastReplyMs)}</p>
            <p className="text-xs text-amber-600">Consider sending a follow-up to keep the conversation active.</p>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 flex-col lg:flex-row overflow-hidden">
        {/* Message thread.
            `min-w-0` on this flex item lets it shrink below its
            intrinsic content width — without this, the right sidebar
            (lg:w-96 = 384px) would push the total past the viewport
            edge by ~60px and get clipped behind the parent's
            overflow-hidden, hiding the Internal Notes "Send" button
            and other actionable controls. Default flex-item min-width
            is `auto` which prevents shrink-to-fit; `min-w-0` is the
            standard fix. */}
        <div className="flex flex-1 flex-col min-h-0 min-w-0">
          <div className="flex-1 overflow-y-auto px-4 sm:px-6">
            {messages && messages.length > 0 ? (
              <>
              <ConversationThread messages={messages} channel={channel} conversationId={id} />
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

          {/* Scheduled messages for this conversation (self-hides when empty) */}
          <div className="shrink-0 px-4 sm:px-6 pb-3">
            <ScheduledMessagesList conversationId={id} />
          </div>

          {/* Bottom action bar */}
          <div className="shrink-0 border-t border-gray-200 bg-white px-4 sm:px-6 py-5">
            <ConversationActions
              conversationId={id}
              accountId={conversation.account_id}
              accountName={accountName}
              channel={channel}
              aiReplyId={aiReply?.id || null}
              aiReplyStatus={aiReply?.status || null}
              aiDraftText={aiReply?.draft_text || aiReply?.edited_text || null}
              participantEmail={conversation.participant_email}
              participantName={participantName}
              emailSubject={emailSubject}
              teamsChatId={conversation.teams_chat_id || null}
              conversationStatus={status}
              currentUserId={currentUserId}
              currentUserName={currentUserName}
            />
          </div>
        </div>

        {/* Right sidebar - below thread on mobile, side panel on desktop */}
        <div className="w-full lg:w-96 shrink-0 overflow-y-auto border-t lg:border-t-0 lg:border-l border-gray-200 bg-gray-50 p-6 space-y-6">
          <AISidebar
            classification={classification}
            aiReply={mappedAiReply}
            kbArticles={kbArticleTitles}
            sentimentHistory={sentimentHistory}
            customerHistory={customerHistory}
            channel={channel}
            conversationId={id}
            teamsContext={channel === 'teams' ? {
              chatType: conversation.teams_chat_id?.includes('uni01_') ? '1:1' : 'group',
              accountName: accountName.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim(),
              participantName,
              messageCount,
            } : null}
          />
          <ConversationTagPicker
            conversationId={id}
            initialTags={(conversation.tags as string[] | null) ?? []}
          />
          <ConversationTimeDisplay conversationId={id} />
          <InternalNotes conversationId={id} authorName={currentUserName || undefined} />
          <ActivityTimeline conversationId={id} />
        </div>
      </div>
    </div>
  )
}
