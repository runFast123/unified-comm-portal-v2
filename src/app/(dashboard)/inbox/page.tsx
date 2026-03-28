'use client'

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { CheckSquare, Archive, UserPlus, Loader2, Inbox, List, Columns, X, Sparkles, User, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InboxList } from '@/components/inbox/inbox-list'
import { InboxFiltersBar, type InboxFilters } from '@/components/inbox/inbox-filters'
import { InboxPreview } from '@/components/inbox/inbox-preview'
import { createClient } from '@/lib/supabase-client'
import { useToast } from '@/components/ui/toast'
import { useRealtimeMessages } from '@/hooks/useRealtimeMessages'
import type { InboxItem, Priority } from '@/types/database'
import { useUser } from '@/context/user-context'

type ViewMode = 'list' | 'split'

const defaultFilters: InboxFilters = {
  channel: 'all',
  category: 'all',
  sentiment: 'all',
  priority: 'all',
  search: '',
}

/** Map ai_replies.status to the UI's ai_status enum */
function mapAiStatus(
  aiReplyStatus: string | null | undefined,
  phase2Enabled: boolean
): InboxItem['ai_status'] {
  if (!phase2Enabled) return 'classify_only'
  if (!aiReplyStatus) return 'no_draft'
  switch (aiReplyStatus) {
    case 'pending_approval':
    case 'edited':
      return 'draft_ready'
    case 'sent':
    case 'auto_sent':
    case 'approved':
      return 'auto_sent'
    case 'rejected':
      return 'no_draft'
    default:
      return 'no_draft'
  }
}

/** Calculate relative time from a date string */
function getRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Unknown'
  const now = new Date()
  const date = new Date(dateStr)
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

/** Derive priority from urgency when there is no explicit priority field on messages */
function derivePriority(urgency: string | null | undefined): Priority {
  switch (urgency) {
    case 'urgent':
      return 'urgent'
    case 'high':
      return 'high'
    case 'medium':
      return 'medium'
    default:
      return 'low'
  }
}

export default function InboxPage() {
  const { isAdmin, account_id: userAccountId } = useUser()
  const { toast } = useToast()
  const searchParams = useSearchParams()
  const [filters, setFilters] = useState<InboxFilters>(() => {
    // Initialize filters from URL search params if present
    if (typeof window === 'undefined') return defaultFilters
    const params = new URLSearchParams(window.location.search)
    const channel = params.get('channel')
    const category = params.get('category')
    const sentiment = params.get('sentiment')
    return {
      channel: (channel && ['teams', 'email', 'whatsapp'].includes(channel) ? channel : 'all') as InboxFilters['channel'],
      category: (category || 'all') as InboxFilters['category'],
      sentiment: (sentiment || 'all') as InboxFilters['sentiment'],
      priority: 'all' as InboxFilters['priority'],
      search: '',
    }
  })
  const [items, setItems] = useState<InboxItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('list')

  // Load view mode from localStorage after mount (avoids hydration mismatch)
  useEffect(() => {
    const stored = localStorage.getItem('inbox-view-mode') as ViewMode | null
    if (stored === 'list' || stored === 'split') setViewMode(stored)
  }, [])
  const [selectedItem, setSelectedItem] = useState<InboxItem | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmAction, setConfirmAction] = useState<{
    type: 'approve' | 'archive' | 'smart-approve'
    count: number
    totalCount?: number
  } | null>(null)
  const [bulkActionLoading, setBulkActionLoading] = useState(false)
  const [newMessageCount, setNewMessageCount] = useState(0)
  const [myConversationsOnly, setMyConversationsOnly] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [spamView, setSpamView] = useState(() => {
    if (typeof window !== 'undefined') return new URLSearchParams(window.location.search).get('spam') === 'true'
    return false
  })
  const [spamCount, setSpamCount] = useState(0)
  // Dashboard filter from URL params (e.g., ?filter=pending, ?filter=sla_breached)
  const [dashboardFilter] = useState<string | null>(() => {
    if (typeof window !== 'undefined') return new URLSearchParams(window.location.search).get('filter')
    return null
  })
  const listTopRef = useRef<HTMLDivElement>(null)

  // Get the current authenticated user's ID
  useEffect(() => {
    async function getCurrentUser() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      setCurrentUserId(user?.id ?? null)
    }
    getCurrentUser()
  }, [])

  const handleSelectionChange = useCallback((ids: Set<string>) => {
    setSelectedIds(ids)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode)
    if (typeof window !== 'undefined') {
      localStorage.setItem('inbox-view-mode', mode)
    }
    if (mode === 'list') {
      setSelectedItem(null)
    }
  }, [])

  const handleItemClick = useCallback((item: InboxItem) => {
    setSelectedItem(item)
  }, [])

  const fetchInboxItems = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const supabase = createClient()

      // Fetch inbound messages with joined data
      let messagesQuery = supabase
        .from('messages')
        .select(`
          id,
          conversation_id,
          account_id,
          channel,
          sender_name,
          message_text,
          email_subject,
          direction,
          reply_required,
          replied,
          is_spam,
          spam_reason,
          timestamp,
          received_at,
          accounts!messages_account_id_fkey ( id, name, phase2_enabled ),
          message_classifications ( category, sentiment, urgency, confidence, classified_at ),
          ai_replies ( status, created_at ),
          conversations!messages_conversation_id_fkey ( status, assigned_to )
        `)
        .eq('direction', 'inbound')
        .eq('is_spam', spamView)
        .order('received_at', { ascending: false })
        .limit(100)

      // Apply dashboard filter from URL params
      if (dashboardFilter === 'pending') {
        messagesQuery = messagesQuery.eq('reply_required', true).eq('replied', false)
      }

      // Non-admins: only see messages for their company
      if (!isAdmin && userAccountId) {
        messagesQuery = messagesQuery.eq('account_id', userAccountId)
      }

      // Also fetch spam count for the badge
      let spamCountQuery = supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'inbound')
        .eq('is_spam', true)
      if (!isAdmin && userAccountId) {
        spamCountQuery = spamCountQuery.eq('account_id', userAccountId)
      }

      const [messagesResult, spamCountResult] = await Promise.all([
        messagesQuery,
        spamCountQuery,
      ])

      if (messagesResult.error) {
        throw messagesResult.error
      }

      setSpamCount(spamCountResult.count ?? 0)

      const data = messagesResult.data
      if (!data) {
        setItems([])
        setLoading(false)
        return
      }

      const mapped: InboxItem[] = data.map((msg: any) => {
        // accounts comes back as an object (single FK relationship)
        const account = msg.accounts as any
        // message_classifications is a one-to-many — pick the latest by classified_at
        const classification = Array.isArray(msg.message_classifications)
          ? [...msg.message_classifications].sort((a: any, b: any) =>
              new Date(b.classified_at || 0).getTime() - new Date(a.classified_at || 0).getTime()
            )[0] ?? null
          : msg.message_classifications ?? null
        // ai_replies is one-to-many — pick the latest by created_at
        const aiReply = Array.isArray(msg.ai_replies)
          ? [...msg.ai_replies].sort((a: any, b: any) =>
              new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
            )[0] ?? null
          : msg.ai_replies ?? null

        const urgency = classification?.urgency ?? null
        const phase2Enabled = account?.phase2_enabled ?? false
        const conversation = msg.conversations as any

        return {
          id: msg.id,
          channel: msg.channel,
          sender_name: msg.sender_name,
          account_name: account?.name ?? 'Unknown Account',
          account_id: msg.account_id,
          subject_or_preview: msg.email_subject || msg.message_text || '',
          category: classification?.category ?? null,
          sentiment: classification?.sentiment ?? null,
          urgency,
          time_waiting: msg.received_at ?? msg.timestamp ?? '',
          priority: derivePriority(urgency),
          ai_status: mapAiStatus(aiReply?.status, phase2Enabled),
          ai_confidence: classification?.confidence ?? null,
          message_id: msg.id,
          conversation_id: msg.conversation_id,
          conversation_status: conversation?.status ?? null,
          assigned_to: conversation?.assigned_to ?? null,
          timestamp: msg.timestamp,
          is_spam: msg.is_spam ?? false,
          spam_reason: msg.spam_reason ?? null,
        } satisfies InboxItem
      })

      setItems(mapped)
    } catch (err: any) {
      console.error('Failed to fetch inbox items:', err)
      setError(err.message ?? 'Failed to load inbox messages')
    } finally {
      setLoading(false)
    }
  }, [isAdmin, userAccountId, spamView, dashboardFilter])

  useEffect(() => {
    fetchInboxItems()
  }, [fetchInboxItems])

  // Real-time: track new messages with banner instead of auto-refresh
  useRealtimeMessages({
    onNewMessage: useCallback(() => {
      setNewMessageCount((prev) => prev + 1)
    }, []),
  })

  // Handler for the new message banner
  const handleRefreshNewMessages = useCallback(() => {
    setNewMessageCount(0)
    fetchInboxItems()
    listTopRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [fetchInboxItems])

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (myConversationsOnly && currentUserId && item.assigned_to !== currentUserId) return false
      if (filters.channel !== 'all' && item.channel !== filters.channel) return false
      if (filters.category !== 'all' && item.category !== filters.category) return false
      if (filters.sentiment !== 'all' && item.sentiment !== filters.sentiment) return false
      if (filters.priority !== 'all' && item.priority !== filters.priority) return false
      if (
        filters.search &&
        !item.subject_or_preview.toLowerCase().includes(filters.search.toLowerCase()) &&
        !item.sender_name?.toLowerCase().includes(filters.search.toLowerCase()) &&
        !item.account_name.toLowerCase().includes(filters.search.toLowerCase())
      ) {
        return false
      }
      return true
    })
  }, [items, filters, myConversationsOnly, currentUserId])

  const handleMarkNotSpam = useCallback(async (messageId: string) => {
    const supabase = createClient()
    const { error: err } = await supabase
      .from('messages')
      .update({ is_spam: false, spam_reason: null, reply_required: true })
      .eq('id', messageId)
    if (err) {
      toast.error('Failed to mark as not spam: ' + err.message)
    } else {
      setItems((prev) => prev.filter((item) => item.message_id !== messageId))
      setSpamCount((prev) => Math.max(0, prev - 1))
      toast.success('Message moved back to inbox.')
    }
  }, [toast])

  const handleMarkNotSpamBulk = useCallback(async () => {
    const ids = selectedIds.size > 0
      ? filteredItems.filter((item) => selectedIds.has(item.id)).map((item) => item.message_id)
      : filteredItems.map((item) => item.message_id)
    if (ids.length === 0) return
    const supabase = createClient()
    const { error: err } = await supabase
      .from('messages')
      .update({ is_spam: false, spam_reason: null, reply_required: true })
      .in('id', ids)
    if (err) {
      toast.error('Failed to mark as not spam: ' + err.message)
    } else {
      setItems((prev) => prev.filter((item) => !ids.includes(item.message_id)))
      setSpamCount((prev) => Math.max(0, prev - ids.length))
      clearSelection()
      toast.success(`Moved ${ids.length} message(s) back to inbox.`)
    }
  }, [filteredItems, selectedIds, toast, clearSelection])

  return (
    <div className="space-y-6 animate-fade-in">
      {/* New messages banner (Feature 3) */}
      {newMessageCount > 0 && (
        <div
          onClick={handleRefreshNewMessages}
          className="fixed top-4 left-1/2 z-50 -translate-x-1/2 cursor-pointer animate-fade-in"
        >
          <div className="flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-5 py-2.5 shadow-lg hover:bg-teal-100 transition-colors">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-teal-500" />
            </span>
            <span className="text-sm font-medium text-teal-800">
              {newMessageCount} new message{newMessageCount > 1 ? 's' : ''} — Click to refresh
            </span>
          </div>
        </div>
      )}

      {/* Scroll anchor */}
      <div ref={listTopRef} />

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          {spamView ? 'Spam / Junk' : 'Unified Inbox'}
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          {spamView
            ? 'Messages automatically filtered as spam or junk'
            : 'All pending messages across channels in one place'}
        </p>
      </div>

      {/* Dashboard filter banner */}
      {(dashboardFilter || filters.channel !== 'all' || filters.category !== 'all' || filters.sentiment !== 'all') && (searchParams.get('filter') || searchParams.get('channel') || searchParams.get('category') || searchParams.get('sentiment')) && (
        <div className="flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-4 py-2 text-sm">
          <span className="font-medium text-teal-800">
            Filtered view from Dashboard:
          </span>
          <span className="text-teal-600">
            {dashboardFilter === 'pending' && 'Pending replies'}
            {dashboardFilter === 'ai_processed' && 'AI processed messages'}
            {dashboardFilter === 'sla_breached' && 'SLA breached messages'}
            {!dashboardFilter && filters.channel !== 'all' && `Channel: ${filters.channel}`}
            {!dashboardFilter && filters.category !== 'all' && `Category: ${filters.category}`}
            {!dashboardFilter && filters.sentiment !== 'all' && `Sentiment: ${filters.sentiment}`}
          </span>
          <button
            onClick={() => {
              setFilters(defaultFilters)
              window.history.replaceState({}, '', '/inbox')
            }}
            className="ml-auto text-teal-600 hover:text-teal-800"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Spam / Inbox toggle */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => { setSpamView(false); setSelectedItem(null) }}
          className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            !spamView
              ? 'bg-teal-600 text-white shadow-sm'
              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
          }`}
        >
          <Inbox size={16} />
          Inbox
        </button>
        <button
          onClick={() => { setSpamView(true); setSelectedItem(null) }}
          className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            spamView
              ? 'bg-orange-600 text-white shadow-sm'
              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
          }`}
        >
          <ShieldAlert size={16} />
          Spam
          {spamCount > 0 && (
            <span className="ml-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-orange-100 px-1.5 text-xs font-semibold text-orange-700">
              {spamCount > 99 ? '99+' : spamCount}
            </span>
          )}
        </button>
      </div>

      {/* Filters */}
      {!spamView && (
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <InboxFiltersBar filters={filters} onChange={setFilters} />
        </div>
        <button
          onClick={() => setMyConversationsOnly(!myConversationsOnly)}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
            myConversationsOnly
              ? 'bg-teal-600 text-white shadow-sm'
              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
          }`}
        >
          <User size={14} />
          My Conversations
        </button>
      </div>
      )}

      {/* Actions bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-gray-600">
            Showing{' '}
            <span className="font-semibold text-gray-900">{filteredItems.length}</span>{' '}
            of{' '}
            <span className="font-semibold text-gray-900">{items.length}</span>{' '}
            {items.length === 1 ? 'message' : 'messages'}
          </p>
          {/* View mode toggle - hidden on mobile (split view not usable) */}
          <div className="hidden sm:flex items-center rounded-lg border border-gray-200 bg-white p-0.5">
            <button
              onClick={() => handleViewModeChange('list')}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === 'list'
                  ? 'bg-teal-600 text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
              title="List view"
            >
              <List size={14} />
              List
            </button>
            <button
              onClick={() => handleViewModeChange('split')}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === 'split'
                  ? 'bg-teal-600 text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
              title="Split view"
            >
              <Columns size={14} />
              Split
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Smart Approve: only messages with AI confidence > 85% */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const highConfidenceItems = filteredItems.filter(
                (item) => item.ai_status === 'draft_ready' && (item.ai_confidence ?? 0) > 85
              )
              if (highConfidenceItems.length === 0) {
                toast.warning('No drafts with >85% AI confidence to approve.')
                return
              }
              const totalDrafts = filteredItems.filter((item) => item.ai_status === 'draft_ready').length
              setConfirmAction({
                type: 'smart-approve',
                count: highConfidenceItems.length,
                totalCount: totalDrafts,
              })
            }}
          >
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline">Smart Approve</span>
            <span className="sm:hidden">Approve</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="hidden sm:inline-flex"
            onClick={() => {
              toast.info('Assign All: Coming soon')
            }}
          >
            <UserPlus className="h-4 w-4" />
            Assign All
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const messageIds = filteredItems.map((item) => item.message_id)
              if (messageIds.length === 0) {
                toast.warning('No messages to archive.')
                return
              }
              setConfirmAction({ type: 'archive', count: messageIds.length })
            }}
          >
            <Archive className="h-4 w-4" />
            Archive All
          </Button>
        </div>
      </div>

      {/* Confirmation Dialog */}
      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Confirm Action</h3>
            <p className="mt-2 text-sm text-gray-600">
              {confirmAction.type === 'smart-approve' &&
                `Approve ${confirmAction.count} of ${confirmAction.totalCount} messages with >85% AI confidence?`}
              {confirmAction.type === 'approve' &&
                `Are you sure you want to approve ${confirmAction.count} selected message${confirmAction.count > 1 ? 's' : ''}?`}
              {confirmAction.type === 'archive' &&
                `Are you sure you want to archive ${confirmAction.count} message${confirmAction.count > 1 ? 's' : ''}? This cannot be undone.`}
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmAction(null)}
                disabled={bulkActionLoading}
              >
                Cancel
              </Button>
              <Button
                variant={confirmAction.type === 'archive' ? 'danger' : 'primary'}
                size="sm"
                loading={bulkActionLoading}
                onClick={async () => {
                  setBulkActionLoading(true)
                  const supabase = createClient()

                  try {
                    if (confirmAction.type === 'smart-approve') {
                      const highConfidenceIds = filteredItems
                        .filter((item) => item.ai_status === 'draft_ready' && (item.ai_confidence ?? 0) > 85)
                        .map((item) => item.message_id)
                      const { error: err } = await supabase
                        .from('ai_replies')
                        .update({ status: 'approved', reviewed_at: new Date().toISOString() })
                        .in('message_id', highConfidenceIds)
                        .in('status', ['pending_approval', 'edited'])
                      if (err) {
                        toast.error('Failed to approve: ' + err.message)
                      } else {
                        toast.success(`Approved ${highConfidenceIds.length} high-confidence draft(s).`)
                        fetchInboxItems()
                      }
                    } else if (confirmAction.type === 'approve') {
                      const idsToApprove = filteredItems
                        .filter((item) => selectedIds.has(item.id) && item.ai_status === 'draft_ready')
                        .map((item) => item.message_id)
                      if (idsToApprove.length === 0) {
                        toast.warning('None of the selected messages have approvable drafts.')
                      } else {
                        const { error: err } = await supabase
                          .from('ai_replies')
                          .update({ status: 'approved', reviewed_at: new Date().toISOString() })
                          .in('message_id', idsToApprove)
                          .in('status', ['pending_approval', 'edited'])
                        if (err) {
                          toast.error('Failed to approve: ' + err.message)
                        } else {
                          toast.success(`Approved ${idsToApprove.length} draft(s).`)
                          clearSelection()
                          fetchInboxItems()
                        }
                      }
                    } else if (confirmAction.type === 'archive') {
                      const messageIds = selectedIds.size > 0
                        ? filteredItems.filter((item) => selectedIds.has(item.id)).map((item) => item.message_id)
                        : filteredItems.map((item) => item.message_id)
                      // When archiving spam messages, also clear is_spam so they don't reappear in spam view on refresh
                      const updateFields = spamView
                        ? { replied: true, reply_required: false, is_spam: false }
                        : { replied: true, reply_required: false }
                      const { error: err } = await supabase
                        .from('messages')
                        .update(updateFields)
                        .in('id', messageIds)
                      if (err) {
                        toast.error('Failed to archive: ' + err.message)
                      } else {
                        setItems((prev) =>
                          prev.filter((item) => !messageIds.includes(item.message_id))
                        )
                        // Also update spam count badge when archiving spam
                        if (spamView) {
                          setSpamCount((prev) => Math.max(0, prev - messageIds.length))
                        }
                        toast.success(`Archived ${messageIds.length} message(s).`)
                        clearSelection()
                      }
                    }
                  } finally {
                    setBulkActionLoading(false)
                    setConfirmAction(null)
                  }
                }}
              >
                {confirmAction.type === 'archive' ? 'Archive' : 'Approve'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Floating bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-20 sm:bottom-6 left-2 right-2 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-40 animate-fade-in">
          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 rounded-xl border border-gray-200 bg-white px-3 sm:px-5 py-3 shadow-2xl">
            <span className="text-sm font-semibold text-gray-700">
              {selectedIds.size} selected
            </span>
            <div className="hidden sm:block h-5 w-px bg-gray-200" />
            <Button
              variant="success"
              size="sm"
              onClick={() => {
                const selectedDraftReady = filteredItems.filter(
                  (item) => selectedIds.has(item.id) && item.ai_status === 'draft_ready'
                )
                if (selectedDraftReady.length === 0) {
                  toast.warning('None of the selected messages have approvable drafts.')
                  return
                }
                setConfirmAction({ type: 'approve', count: selectedDraftReady.length })
              }}
            >
              <CheckSquare className="h-4 w-4" />
              <span className="hidden sm:inline">Approve Selected</span>
              <span className="sm:hidden">Approve</span>
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setConfirmAction({ type: 'archive', count: selectedIds.size })
              }}
            >
              <Archive className="h-4 w-4" />
              <span className="hidden sm:inline">Archive Selected</span>
              <span className="sm:hidden">Archive</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="hidden sm:inline-flex"
              onClick={() => {
                toast.info('Assign to: Coming soon')
              }}
            >
              <UserPlus className="h-4 w-4" />
              Assign to...
            </Button>
            <button
              onClick={clearSelection}
              className="ml-1 rounded-full p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              title="Clear selection"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-gray-200 bg-white py-16">
          <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
          <p className="mt-3 text-sm text-gray-500">Loading messages...</p>
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-red-200 bg-red-50 py-12">
          <p className="text-sm font-medium text-red-800">Failed to load messages</p>
          <p className="mt-1 text-xs text-red-600">{error}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={fetchInboxItems}
          >
            Try again
          </Button>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && items.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-gray-200 bg-white py-16">
          {spamView ? (
            <>
              <ShieldCheck className="h-10 w-10 text-green-300" />
              <p className="mt-3 text-sm font-medium text-gray-700">No spam messages</p>
              <p className="mt-1 text-xs text-gray-500">
                Your inbox is clean -- no messages have been flagged as spam.
              </p>
            </>
          ) : (
            <>
              <Inbox className="h-10 w-10 text-gray-300" />
              <p className="mt-3 text-sm font-medium text-gray-700">All caught up!</p>
              <p className="mt-1 text-xs text-gray-500">
                Messages will appear here once your channels start receiving them.
              </p>
            </>
          )}
        </div>
      )}

      {/* Filtered empty state */}
      {!loading && !error && items.length > 0 && filteredItems.length === 0 && !spamView && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-gray-200 bg-white py-16">
          <Inbox className="h-10 w-10 text-gray-300" />
          <p className="mt-3 text-sm font-medium text-gray-700">
            No messages match your filters
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Try adjusting your filters or check back later
          </p>
        </div>
      )}

      {/* Spam list */}
      {!loading && !error && spamView && items.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              <span className="font-semibold text-gray-900">{items.length}</span>{' '}
              spam message{items.length !== 1 ? 's' : ''}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleMarkNotSpamBulk}
            >
              <ShieldCheck className="h-4 w-4" />
              Mark All Not Spam
            </Button>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {item.sender_name || 'Unknown'}
                    </span>
                    <span className="text-xs text-gray-400">
                      {item.channel}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 truncate mt-0.5">
                    {item.subject_or_preview || '(no subject)'}
                  </p>
                  {item.spam_reason && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <ShieldAlert className="h-3.5 w-3.5 text-orange-500 flex-shrink-0" />
                      <span className="text-xs text-orange-600">{item.spam_reason}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs text-gray-400 whitespace-nowrap">
                    {getRelativeTime(item.time_waiting)}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleMarkNotSpam(item.message_id)}
                  >
                    Not Spam
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inbox list */}
      {!loading && !error && !spamView && filteredItems.length > 0 && viewMode === 'list' && (
        <InboxList
          items={filteredItems}
          selectedIds={selectedIds}
          onSelectionChange={handleSelectionChange}
        />
      )}

      {/* Split view */}
      {!loading && !error && !spamView && filteredItems.length > 0 && viewMode === 'split' && (
        <div className="flex rounded-lg border border-gray-200 bg-white overflow-hidden" style={{ height: 'calc(100vh - 320px)' }}>
          {/* Left: message list (narrower) */}
          <div className="w-[45%] shrink-0 overflow-y-auto border-r border-gray-200">
            <InboxList
              items={filteredItems}
              onItemClick={handleItemClick}
              selectedItemId={selectedItem?.id || null}
              selectedIds={selectedIds}
              onSelectionChange={handleSelectionChange}
            />
          </div>

          {/* Right: conversation preview */}
          <div className="flex-1 overflow-hidden bg-gray-50">
            {selectedItem ? (
              <InboxPreview item={selectedItem} />
            ) : (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <Inbox className="mx-auto h-10 w-10 text-gray-300" />
                  <p className="mt-3 text-sm font-medium text-gray-500">
                    Select a message to preview
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    Click any message on the left to see the conversation
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
