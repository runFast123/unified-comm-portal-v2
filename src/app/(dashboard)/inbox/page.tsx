'use client'

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { CheckSquare, CheckCheck, Archive, UserPlus, Loader2, Inbox, List, Columns, LayoutGrid, X, Sparkles, User, ShieldAlert, ShieldCheck, Mail, CircleCheck, RefreshCw, Bookmark, BookmarkPlus, Clock, ChevronLeft, Filter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { InboxRowSkeleton } from '@/components/ui/skeleton'
import { InboxList } from '@/components/inbox/inbox-list'
import { InboxFiltersBar, type InboxFilters } from '@/components/inbox/inbox-filters'
import { InboxPreview } from '@/components/inbox/inbox-preview'
import { InboxKanban } from '@/components/inbox/inbox-kanban'
import { SavedViewModal, getSavedViewIcon } from '@/components/inbox/saved-view-modal'
import {
  InboxFacetsSidebar,
  readFacetFiltersFromSearch,
  writeFacetFiltersToSearch,
  type FacetActiveFilters,
  type FacetFilterKey,
} from '@/components/dashboard/inbox-facets-sidebar'
import type { InboxFacets } from '@/app/api/inbox/facets/route'
import { createClient } from '@/lib/supabase-client'
import { useToast } from '@/components/ui/toast'
import { useRealtimeMessages } from '@/hooks/useRealtimeMessages'
import type { InboxItem, Priority, SavedView, SavedViewFilters } from '@/types/database'
import { useUser } from '@/context/user-context'

type ViewMode = 'list' | 'split' | 'kanban'

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
  const { isAdmin, account_id: userAccountId, companyAccountIds } = useUser()
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
  // ── Smart-inbox sidebar facets ────────────────────────────────────────
  // Stores extra filter dimensions (urgency, status, assignment) that the
  // existing top filters bar doesn't expose. URL-backed so refresh survives.
  const [facetFilters, setFacetFilters] = useState<FacetActiveFilters>(() => {
    if (typeof window === 'undefined') return {}
    return readFacetFiltersFromSearch(new URLSearchParams(window.location.search))
  })
  const [facets, setFacets] = useState<InboxFacets | null>(null)
  const [facetsLoading, setFacetsLoading] = useState(false)
  const [sidebarOpenMobile, setSidebarOpenMobile] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<FacetFilterKey>>(new Set())

  const INBOX_PAGE_SIZE = 50
  const [items, setItems] = useState<InboxItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('list')

  // Load view mode from localStorage after mount (avoids hydration mismatch)
  useEffect(() => {
    const stored = localStorage.getItem('inbox-view-mode') as ViewMode | null
    if (stored === 'list' || stored === 'split' || stored === 'kanban') setViewMode(stored)
  }, [])
  const [selectedItem, setSelectedItem] = useState<InboxItem | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmAction, setConfirmAction] = useState<{
    type: 'approve' | 'archive' | 'smart-approve' | 'mark_replied' | 'resolve' | 'assign_me'
    count: number
    totalCount?: number
  } | null>(null)
  const [bulkActionLoading, setBulkActionLoading] = useState(false)
  const [newMessageCount, setNewMessageCount] = useState(0)
  const [myConversationsOnly, setMyConversationsOnly] = useState(false)
  // ── Snooze filter ────────────────────────────────────────────────────
  // Default behaviour: snoozed conversations are hidden until their snooze
  // expires (the wake-snoozed cron will null out `snoozed_until` and the row
  // re-appears here naturally). When toggled on, snoozed rows are included
  // and tagged with a yellow "Snoozed until …" badge in <InboxRow>.
  const [showSnoozed, setShowSnoozed] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  type InboxView = 'inbox' | 'newsletter' | 'spam'
  const [inboxView, setInboxView] = useState<InboxView>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      if (params.get('spam') === 'true') return 'spam'
      if (params.get('newsletter') === 'true') return 'newsletter'
    }
    return 'inbox'
  })
  const [spamCount, setSpamCount] = useState(0)
  const [newsletterCount, setNewsletterCount] = useState(0)
  // Dashboard filter from URL params (e.g., ?filter=pending, ?filter=sla_breached)
  const [dashboardFilter] = useState<string | null>(() => {
    if (typeof window !== 'undefined') return new URLSearchParams(window.location.search).get('filter')
    return null
  })
  const listTopRef = useRef<HTMLDivElement>(null)

  // ── Saved views (smart inboxes) ──────────────────────────────────
  // When ?view=ID is in the URL, fetch the matching view and apply its
  // filter blob to the current InboxFilters state. Resolving 'me' for the
  // assignee field happens at apply time (we have currentUserId by then).
  const [activeView, setActiveView] = useState<SavedView | null>(null)
  const [showSaveViewModal, setShowSaveViewModal] = useState(false)
  const [editingView, setEditingView] = useState<SavedView | null>(null)
  const viewParam = searchParams.get('view')
  useEffect(() => {
    if (!viewParam) {
      setActiveView(null)
      return
    }
    let cancelled = false
    fetch('/api/saved-views')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const found = (data?.views as SavedView[] | undefined)?.find((v) => v.id === viewParam)
        if (!found) return
        setActiveView(found)
        // Apply the view's filters to the current InboxFilters state. The
        // saved-view shape is a SUPERSET of InboxFilters — fields the inbox
        // bar doesn't render (status, assignee, age_hours_gt, account_ids,
        // unread_only) are kept on `activeView.filters` and applied in the
        // memoized `filteredItems` filter below.
        const f = found.filters || {}
        setFilters((prev) => ({
          ...prev,
          channel: (f.channel as InboxFilters['channel']) ?? prev.channel,
          category: (f.category as InboxFilters['category']) ?? prev.category,
          sentiment: (f.sentiment as InboxFilters['sentiment']) ?? prev.sentiment,
          priority: (f.priority as InboxFilters['priority']) ?? prev.priority,
          search: f.search ?? prev.search,
        }))
      })
      .catch(() => { /* fall back to current filters */ })
    return () => { cancelled = true }
  }, [viewParam])

  const clearActiveView = useCallback(() => {
    setActiveView(null)
    setFilters(defaultFilters)
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      params.delete('view')
      const qs = params.toString()
      window.history.replaceState({}, '', qs ? `/inbox?${qs}` : '/inbox')
    }
  }, [])

  /** Build a SavedViewFilters blob from the current InboxFilters state. */
  const currentFiltersAsView = useCallback((): SavedViewFilters => {
    const out: SavedViewFilters = {}
    if (filters.channel !== 'all') out.channel = filters.channel
    if (filters.category !== 'all') out.category = filters.category as string
    if (filters.sentiment !== 'all') out.sentiment = filters.sentiment
    if (filters.priority !== 'all') out.priority = filters.priority
    if (filters.search) out.search = filters.search
    if (myConversationsOnly) out.assignee = 'me'
    return out
  }, [filters, myConversationsOnly])

  const hasNonDefaultFilters = useMemo(() => {
    return (
      filters.channel !== 'all' ||
      filters.category !== 'all' ||
      filters.sentiment !== 'all' ||
      filters.priority !== 'all' ||
      !!filters.search ||
      myConversationsOnly
    )
  }, [filters, myConversationsOnly])

  // Get the current authenticated user's ID
  useEffect(() => {
    async function getCurrentUser() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      setCurrentUserId(user?.id ?? null)
    }
    getCurrentUser()
  }, [])

  // ── Smart-inbox sidebar: fetch facets whenever the active filters change.
  // Counts are scoped server-side; the response also drives chip enable/disable.
  useEffect(() => {
    let cancelled = false
    setFacetsLoading(true)
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(facetFilters)) {
      if (value) params.set(key, value)
    }
    fetch(`/api/inbox/facets?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: InboxFacets | null) => {
        if (!cancelled && data) setFacets(data)
      })
      .catch(() => { /* network error — keep stale facets */ })
      .finally(() => { if (!cancelled) setFacetsLoading(false) })
    return () => { cancelled = true }
  }, [facetFilters])

  /**
   * Update facet filters from the sidebar — also writes them to the URL
   * (so refresh / back-button work) and mirrors the channel/category/
   * sentiment fields into the existing `filters` state so the inbox query
   * picks them up server-side too. Multiple filters AND together.
   */
  const handleFacetFiltersChange = useCallback((next: FacetActiveFilters) => {
    setFacetFilters(next)
    if (typeof window !== 'undefined') {
      const current = new URLSearchParams(window.location.search)
      const updated = writeFacetFiltersToSearch(current, next)
      const qs = updated.toString()
      window.history.replaceState({}, '', qs ? `/inbox?${qs}` : '/inbox')
    }
    // Mirror channel/category/sentiment back to the existing filters state
    // so the messages query picks them up server-side. Other facets (urgency,
    // status, assignment) are applied client-side in `filteredItems`.
    setFilters((prev) => ({
      ...prev,
      channel: (next.channel as InboxFilters['channel']) || 'all',
      category: (next.category as InboxFilters['category']) || 'all',
      sentiment: (next.sentiment as InboxFilters['sentiment']) || 'all',
    }))
  }, [])

  const handleToggleFacetSection = useCallback((key: FacetFilterKey) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // Listen for the global `/` keyboard shortcut and focus the search input.
  // The input lives inside <InboxFiltersBar> and is tagged with
  // `data-inbox-search` so we don't need to thread a ref through.
  useEffect(() => {
    const onFocusSearch = () => {
      const el = document.querySelector<HTMLInputElement>('[data-inbox-search]')
      if (el) {
        el.focus()
        el.select()
      }
    }
    window.addEventListener('inbox:focus-search', onFocusSearch)
    return () => window.removeEventListener('inbox:focus-search', onFocusSearch)
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

      // Ensure we have full sibling account IDs for non-admin users
      let resolvedAccountIds = companyAccountIds
      if (!isAdmin && resolvedAccountIds.length <= 1) {
        try {
          const res = await fetch('/api/user-accounts')
          const data = await res.json()
          if (data.accountIds?.length > 0) resolvedAccountIds = data.accountIds
        } catch { /* use context value */ }
      }

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
          conversations!messages_conversation_id_fkey ( status, assigned_to, tags, snoozed_until, merged_into_id )
        `)
        .eq('direction', 'inbound')

      // Apply view-specific spam/newsletter filters
      if (inboxView === 'inbox') {
        messagesQuery = messagesQuery.eq('is_spam', false)
      } else if (inboxView === 'newsletter') {
        messagesQuery = messagesQuery
          .eq('is_spam', true)
          .in('spam_reason', ['newsletter', 'marketing', 'automated_notification', 'ai_classified_newsletter'])
      } else {
        // spam view
        messagesQuery = messagesQuery
          .eq('is_spam', true)
          .not('spam_reason', 'in', '(newsletter,marketing,automated_notification,ai_classified_newsletter)')
      }

      messagesQuery = messagesQuery
        .order('received_at', { ascending: false })
        .limit(INBOX_PAGE_SIZE)

      // Apply channel filter server-side (so Teams/Email/WhatsApp filter actually fetches correct data)
      if (filters.channel !== 'all') {
        messagesQuery = messagesQuery.eq('channel', filters.channel)
      }

      // Apply dashboard filter from URL params
      if (dashboardFilter === 'pending') {
        messagesQuery = messagesQuery.eq('reply_required', true).eq('replied', false)
      }

      // Non-admins: only see messages for their company
      if (!isAdmin && resolvedAccountIds.length > 0) {
        messagesQuery = messagesQuery.in('account_id', resolvedAccountIds)
      }

      // Also fetch newsletter + spam counts for the badges
      let newsletterCountQuery = supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'inbound')
        .eq('is_spam', true)
        .in('spam_reason', ['newsletter', 'marketing', 'automated_notification', 'ai_classified_newsletter'])
      if (!isAdmin && resolvedAccountIds.length > 0) {
        newsletterCountQuery = newsletterCountQuery.in('account_id', resolvedAccountIds)
      }

      let spamCountQuery = supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'inbound')
        .eq('is_spam', true)
        .not('spam_reason', 'in', '(newsletter,marketing,automated_notification,ai_classified_newsletter)')
      if (!isAdmin && resolvedAccountIds.length > 0) {
        spamCountQuery = spamCountQuery.in('account_id', resolvedAccountIds)
      }

      const [messagesResult, newsletterCountResult, spamCountResult] = await Promise.all([
        messagesQuery,
        newsletterCountQuery,
        spamCountQuery,
      ])

      if (messagesResult.error) {
        throw messagesResult.error
      }

      setNewsletterCount(newsletterCountResult.count ?? 0)
      setSpamCount(spamCountResult.count ?? 0)

      const data = messagesResult.data
      if (!data) {
        setItems([])
        setLoading(false)
        return
      }

      // Drop messages whose conversation has been merged into another (soft
      // merge — the secondary stays for audit but should not surface here).
      const visibleMessages = data.filter((msg: any) => {
        const conv = msg.conversations as { merged_into_id?: string | null } | null
        return !conv?.merged_into_id
      })

      const mapped: InboxItem[] = visibleMessages.map((msg: any) => {
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
          body_preview: msg.message_text ? String(msg.message_text).replace(/\s+/g, ' ').trim().substring(0, 280) : null,
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
          tags: conversation?.tags ?? null,
          timestamp: msg.received_at || msg.timestamp,
          is_spam: msg.is_spam ?? false,
          spam_reason: msg.spam_reason ?? null,
          snoozed_until: conversation?.snoozed_until ?? null,
        } satisfies InboxItem
      })

      // For Teams: group by conversation_id and show only the latest message per conversation
      // Email shows each message individually (each email = separate topic)
      const convMap = new Map<string, InboxItem>()
      const deduped: InboxItem[] = []
      for (const item of mapped) {
        if (item.channel === 'teams') {
          const existing = convMap.get(item.conversation_id)
          if (!existing || item.timestamp > existing.timestamp) {
            convMap.set(item.conversation_id, item)
          }
        } else {
          deduped.push(item)
        }
      }
      // Add the latest Teams message per conversation
      for (const item of convMap.values()) {
        deduped.push(item)
      }
      // Re-sort by timestamp descending
      deduped.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

      setItems(deduped)
      setHasMore(deduped.length >= INBOX_PAGE_SIZE)
      setTotalCount(deduped.length)
    } catch (err: any) {
      console.error('Failed to fetch inbox items:', err)
      setError(err.message ?? 'Failed to load inbox messages')
    } finally {
      setLoading(false)
    }
  }, [isAdmin, companyAccountIds, inboxView, dashboardFilter, filters.channel, INBOX_PAGE_SIZE])

  useEffect(() => {
    fetchInboxItems()
  }, [fetchInboxItems])

  // Load more messages (append to existing list)
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const supabase = createClient()
      const lastItem = items[items.length - 1]
      if (!lastItem) return

      let moreQuery = supabase
        .from('messages')
        .select(`
          id, conversation_id, account_id, channel, sender_name, message_text,
          email_subject, direction, reply_required, replied, is_spam, spam_reason,
          timestamp, received_at,
          accounts!messages_account_id_fkey ( id, name, phase2_enabled ),
          message_classifications ( category, sentiment, urgency, confidence, classified_at ),
          ai_replies ( status, created_at ),
          conversations!messages_conversation_id_fkey ( status, assigned_to, tags, snoozed_until, merged_into_id )
        `)
        .eq('direction', 'inbound')
        .lt('received_at', lastItem.timestamp)
        .order('received_at', { ascending: false })
        .limit(INBOX_PAGE_SIZE)

      if (inboxView === 'inbox') moreQuery = moreQuery.eq('is_spam', false)
      else if (inboxView === 'newsletter') moreQuery = moreQuery.eq('is_spam', true).in('spam_reason', ['newsletter', 'marketing', 'automated_notification', 'ai_classified_newsletter'])
      else moreQuery = moreQuery.eq('is_spam', true).not('spam_reason', 'in', '(newsletter,marketing,automated_notification,ai_classified_newsletter)')

      if (filters.channel !== 'all') moreQuery = moreQuery.eq('channel', filters.channel)
      if (!isAdmin && companyAccountIds.length > 0) moreQuery = moreQuery.in('account_id', companyAccountIds)

      const { data: moreMessages } = await moreQuery

      if (moreMessages && moreMessages.length > 0) {
        const visibleMore = moreMessages.filter((msg: any) => {
          const conv = msg.conversations as { merged_into_id?: string | null } | null
          return !conv?.merged_into_id
        })
        const mapped: InboxItem[] = visibleMore.map((msg: any) => {
          const account = msg.accounts as any
          const classification = Array.isArray(msg.message_classifications)
            ? [...msg.message_classifications].sort((a: any, b: any) => new Date(b.classified_at || 0).getTime() - new Date(a.classified_at || 0).getTime())[0] ?? null
            : msg.message_classifications ?? null
          const aiReply = Array.isArray(msg.ai_replies)
            ? [...msg.ai_replies].sort((a: any, b: any) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())[0] ?? null
            : msg.ai_replies ?? null
          const conv = msg.conversations as any
          return {
            id: msg.id,
            message_id: msg.id,
            conversation_id: msg.conversation_id,
            account_id: msg.account_id,
            account_name: account?.name || 'Unknown',
            channel: msg.channel,
            sender_name: msg.sender_name,
            subject_or_preview: msg.email_subject || msg.message_text?.substring(0, 100) || 'No preview',
            body_preview: msg.message_text ? String(msg.message_text).replace(/\s+/g, ' ').trim().substring(0, 280) : null,
            timestamp: msg.received_at || msg.timestamp,
            time_waiting: msg.received_at || msg.timestamp,
            is_read: msg.replied,
            priority: derivePriority(classification?.urgency) as Priority,
            category: classification?.category || null,
            sentiment: classification?.sentiment || null,
            ai_status: mapAiStatus(aiReply?.status, account?.phase2_enabled ?? false),
            urgency: (classification?.urgency || null) as any,
            ai_confidence: classification?.confidence != null ? Math.round(Number(classification.confidence) * 100) : null,
            conversation_status: (conv?.status || 'active') as any,
            assigned_to: conv?.assigned_to || null,
            tags: conv?.tags || null,
            is_spam: msg.is_spam ?? false,
            spam_reason: msg.spam_reason ?? null,
            snoozed_until: conv?.snoozed_until ?? null,
          }
        })
        setItems(prev => [...prev, ...mapped])
        setHasMore(moreMessages.length >= INBOX_PAGE_SIZE)
        setTotalCount(prev => prev + mapped.length)
      } else {
        setHasMore(false)
      }
    } catch (err) {
      console.error('Failed to load more:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [items, loadingMore, hasMore, isAdmin, companyAccountIds, inboxView, filters.channel, INBOX_PAGE_SIZE])

  // Real-time: auto-refresh inbox when new messages arrive (debounced 3s)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  useRealtimeMessages({
    onNewMessage: useCallback(() => {
      setNewMessageCount((prev) => prev + 1)
      // Debounce auto-refresh — wait 3s for rapid messages to batch
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        fetchInboxItems()
      }, 3000)
    }, [fetchInboxItems]),
  })

  // ── Inbox sync (fires IMAP/Graph pollers manually — Vercel Cron only runs
  //    in production, so we need this to get new mail locally and on-demand). ──
  const [syncing, setSyncing] = useState(false)
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null)
  const syncStartedRef = useRef(false)

  const handleSync = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    try {
      const res = await fetch('/api/inbox-sync', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.started) {
        toast.info('Sync started — new messages will appear as they arrive')
        setLastSyncAt(new Date())
      } else if (data.reason === 'throttled') {
        const secs = Math.ceil((data.retry_in_ms || 0) / 1000)
        toast.warning(`Sync is throttled — try again in ${secs}s`)
      } else if (data.reason === 'already_running') {
        toast.info('A sync is already in progress')
      } else {
        toast.error(data.error || 'Sync failed to start')
      }
    } catch (err) {
      toast.error('Sync failed: ' + (err instanceof Error ? err.message : 'network error'))
    } finally {
      setSyncing(false)
    }
  }, [syncing, toast])

  // Auto-sync once on first mount so opening /inbox pulls fresh mail.
  useEffect(() => {
    if (syncStartedRef.current) return
    syncStartedRef.current = true
    fetch('/api/inbox-sync', { method: 'POST' })
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        if (data?.started) setLastSyncAt(new Date())
      })
      .catch(() => { /* non-critical */ })
  }, [])

  // Handler for the new message banner (manual refresh + scroll)
  const handleRefreshNewMessages = useCallback(() => {
    setNewMessageCount(0)
    fetchInboxItems()
    listTopRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [fetchInboxItems])

  const filteredItems = useMemo(() => {
    // Pull view-only filter fields (the ones not exposed in InboxFiltersBar).
    // These come from the active saved view (if any) and are applied on top.
    const viewFilters = activeView?.filters ?? {}
    const nowMs = Date.now()
    return items.filter((item) => {
      // Snooze filter: by default hide rows whose snoozed_until is still in
      // the future. When the user toggles "Show snoozed" we keep them.
      if (!showSnoozed && item.snoozed_until && new Date(item.snoozed_until).getTime() > nowMs) {
        return false
      }
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
      // ── Saved-view-only filters ────────────────────────────────────
      if (viewFilters.status && viewFilters.status !== 'all' && item.conversation_status !== viewFilters.status) return false
      if (viewFilters.account_ids && viewFilters.account_ids.length > 0 && !viewFilters.account_ids.includes(item.account_id)) return false
      if (viewFilters.assignee && viewFilters.assignee !== 'all') {
        if (viewFilters.assignee === 'unassigned') {
          if (item.assigned_to) return false
        } else if (viewFilters.assignee === 'me') {
          if (!currentUserId || item.assigned_to !== currentUserId) return false
        } else {
          // Specific user_id
          if (item.assigned_to !== viewFilters.assignee) return false
        }
      }
      if (viewFilters.age_hours_gt && viewFilters.age_hours_gt > 0) {
        const ageHours = (nowMs - new Date(item.timestamp).getTime()) / 36e5
        if (ageHours < viewFilters.age_hours_gt) return false
      }
      // ── Smart-inbox sidebar filters ───────────────────────────────
      // Channel/category/sentiment are mirrored into `filters` (above) so
      // they're already applied. Urgency/status/assignment are sidebar-only.
      if (facetFilters.urgency && (item.urgency ?? null) !== facetFilters.urgency) return false
      if (facetFilters.status && (item.conversation_status ?? null) !== facetFilters.status) return false
      if (facetFilters.assignment) {
        if (facetFilters.assignment === 'me') {
          if (!currentUserId || item.assigned_to !== currentUserId) return false
        } else if (facetFilters.assignment === 'unassigned') {
          if (item.assigned_to) return false
        }
      }
      return true
    })
  }, [items, filters, myConversationsOnly, currentUserId, activeView, showSnoozed, facetFilters])

  // ─── Bulk-action handlers ────────────────────────────────────────────
  // Each handler runs one bulk operation. Where applicable we use .select()
  // so we can compare the count of rows actually updated to the count we
  // asked for, and surface a partial-success warning instead of silently
  // claiming "all succeeded" (e.g., when RLS blocks some rows).

  const selectedMessageIds = useCallback(() => (
    Array.from(new Set(
      filteredItems
        .filter((item) => selectedIds.has(item.id))
        .map((item) => item.message_id)
        .filter(Boolean)
    ))
  ), [filteredItems, selectedIds])

  const selectedConversationIds = useCallback(() => (
    Array.from(new Set(
      filteredItems
        .filter((item) => selectedIds.has(item.id))
        .map((item) => item.conversation_id)
        .filter(Boolean)
    ))
  ), [filteredItems, selectedIds])

  const reportPartial = useCallback((requested: number, actual: number, verb: string) => {
    if (actual === 0) {
      toast.error(`Failed to ${verb} (0 of ${requested} rows updated — likely permission/RLS).`)
    } else if (actual < requested) {
      toast.warning(`${verb.charAt(0).toUpperCase() + verb.slice(1)}d ${actual} of ${requested} (some rows could not be updated).`)
    } else {
      toast.success(`${verb.charAt(0).toUpperCase() + verb.slice(1)}d ${actual}.`)
    }
  }, [toast])

  const handleApproveSelected = useCallback(async () => {
    const supabase = createClient()
    const idsToApprove = filteredItems
      .filter((item) => selectedIds.has(item.id) && item.ai_status === 'draft_ready')
      .map((item) => item.message_id)
    if (idsToApprove.length === 0) {
      toast.warning('None of the selected messages have approvable drafts.')
      return
    }
    const { data, error } = await supabase
      .from('ai_replies')
      .update({ status: 'approved', reviewed_at: new Date().toISOString() })
      .in('message_id', idsToApprove)
      .in('status', ['pending_approval', 'edited'])
      .select('id')
    if (error) {
      toast.error('Failed to approve: ' + error.message)
      return
    }
    reportPartial(idsToApprove.length, data?.length ?? 0, 'approve')
    if ((data?.length ?? 0) > 0) {
      clearSelection()
      fetchInboxItems()
    }
  }, [filteredItems, selectedIds, toast, clearSelection, fetchInboxItems, reportPartial])

  const handleSmartApprove = useCallback(async () => {
    const supabase = createClient()
    const highConfidenceIds = filteredItems
      .filter((item) => item.ai_status === 'draft_ready' && (item.ai_confidence ?? 0) > 85)
      .map((item) => item.message_id)
    const { data, error } = await supabase
      .from('ai_replies')
      .update({ status: 'approved', reviewed_at: new Date().toISOString() })
      .in('message_id', highConfidenceIds)
      .in('status', ['pending_approval', 'edited'])
      .select('id')
    if (error) {
      toast.error('Failed to approve: ' + error.message)
      return
    }
    reportPartial(highConfidenceIds.length, data?.length ?? 0, 'approve')
    if ((data?.length ?? 0) > 0) fetchInboxItems()
  }, [filteredItems, toast, fetchInboxItems, reportPartial])

  const handleMarkRepliedBulk = useCallback(async () => {
    const supabase = createClient()
    const messageIds = selectedIds.size > 0
      ? selectedMessageIds()
      : filteredItems.filter((item) => item.ai_status !== 'auto_sent').map((item) => item.message_id)
    if (messageIds.length === 0) {
      toast.warning('Nothing to mark.')
      return
    }
    const { data, error } = await supabase
      .from('messages')
      .update({ replied: true, reply_required: false })
      .in('id', messageIds)
      .select('id')
    if (error) {
      toast.error('Failed to mark as replied: ' + error.message)
      return
    }
    const updatedIds = new Set((data ?? []).map((r: { id: string }) => r.id))
    reportPartial(messageIds.length, updatedIds.size, 'mark replied')
    if (updatedIds.size > 0) {
      setItems((prev) => prev.filter((item) => !updatedIds.has(item.message_id)))
      clearSelection()
    }
  }, [filteredItems, selectedIds, selectedMessageIds, toast, clearSelection, reportPartial])

  const handleResolveBulk = useCallback(async () => {
    const supabase = createClient()
    const convIds = selectedConversationIds()
    if (convIds.length === 0) {
      toast.warning('Nothing to resolve.')
      return
    }
    const { data: resolvedConvs, error: convErr } = await supabase
      .from('conversations')
      .update({ status: 'resolved' })
      .in('id', convIds)
      .select('id')
    if (convErr) {
      toast.error('Failed to resolve: ' + convErr.message)
      return
    }
    const resolvedSet = new Set((resolvedConvs ?? []).map((r: { id: string }) => r.id))
    if (resolvedSet.size === 0) {
      toast.error(`Failed to resolve (0 of ${convIds.length} conversations updated — likely permission/RLS).`)
      return
    }
    // Mark messages replied for the conversations that actually got resolved
    const msgIds = filteredItems
      .filter((item) => selectedIds.has(item.id) && resolvedSet.has(item.conversation_id))
      .map((item) => item.message_id)
    if (msgIds.length > 0) {
      await supabase
        .from('messages')
        .update({ replied: true, reply_required: false })
        .in('id', msgIds)
      setItems((prev) => prev.filter((item) => !msgIds.includes(item.message_id)))
    }
    if (resolvedSet.size < convIds.length) {
      toast.warning(`Resolved ${resolvedSet.size} of ${convIds.length} conversation(s).`)
    } else {
      toast.success(`Resolved ${resolvedSet.size} conversation(s).`)
    }
    clearSelection()
  }, [filteredItems, selectedIds, selectedConversationIds, toast, clearSelection])

  const handleAssignMeBulk = useCallback(async () => {
    if (!currentUserId) {
      toast.error('Not signed in.')
      return
    }
    const supabase = createClient()
    const convIds = selectedConversationIds()
    if (convIds.length === 0) {
      toast.warning('Nothing to assign.')
      return
    }
    const { data, error } = await supabase
      .from('conversations')
      .update({ assigned_to: currentUserId })
      .in('id', convIds)
      .select('id')
    if (error) {
      toast.error('Failed to assign: ' + error.message)
      return
    }
    reportPartial(convIds.length, data?.length ?? 0, 'assign')
    if ((data?.length ?? 0) > 0) {
      clearSelection()
      fetchInboxItems()
    }
  }, [currentUserId, selectedConversationIds, toast, clearSelection, fetchInboxItems, reportPartial])

  const handleArchiveBulk = useCallback(async () => {
    const supabase = createClient()
    const messageIds = selectedIds.size > 0
      ? selectedMessageIds()
      : filteredItems.map((item) => item.message_id)
    if (messageIds.length === 0) {
      toast.warning('Nothing to archive.')
      return
    }
    // When archiving spam/newsletter messages, also clear is_spam so they don't reappear
    const updateFields = inboxView !== 'inbox'
      ? { replied: true, reply_required: false, is_spam: false }
      : { replied: true, reply_required: false }
    const { data, error } = await supabase
      .from('messages')
      .update(updateFields)
      .in('id', messageIds)
      .select('id')
    if (error) {
      toast.error('Failed to archive: ' + error.message)
      return
    }
    const updatedIds = new Set((data ?? []).map((r: { id: string }) => r.id))
    reportPartial(messageIds.length, updatedIds.size, 'archive')
    if (updatedIds.size > 0) {
      setItems((prev) => prev.filter((item) => !updatedIds.has(item.message_id)))
      if (inboxView === 'newsletter') {
        setNewsletterCount((prev) => Math.max(0, prev - updatedIds.size))
      } else if (inboxView === 'spam') {
        setSpamCount((prev) => Math.max(0, prev - updatedIds.size))
      }
      clearSelection()
    }
  }, [filteredItems, selectedIds, selectedMessageIds, inboxView, toast, clearSelection, reportPartial])

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
      if (inboxView === 'newsletter') {
        setNewsletterCount((prev) => Math.max(0, prev - 1))
      } else {
        setSpamCount((prev) => Math.max(0, prev - 1))
      }
      toast.success('Message moved back to inbox.')
    }
  }, [toast, inboxView])

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
      if (inboxView === 'newsletter') {
        setNewsletterCount((prev) => Math.max(0, prev - ids.length))
      } else {
        setSpamCount((prev) => Math.max(0, prev - ids.length))
      }
      clearSelection()
      toast.success(`Moved ${ids.length} message(s) back to inbox.`)
    }
  }, [filteredItems, selectedIds, toast, clearSelection, inboxView])

  return (
    <div className="flex flex-col md:flex-row md:gap-6 animate-fade-in">
      {/* Smart inbox facets sidebar — only on the main inbox view (not
          spam/newsletter). On mobile it lives off-canvas with a "Filters"
          button to toggle it in. */}
      {inboxView === 'inbox' && (
        <>
          {/* Mobile backdrop */}
          {sidebarOpenMobile && (
            <div
              className="fixed inset-0 z-30 bg-black/30 md:hidden"
              onClick={() => setSidebarOpenMobile(false)}
              aria-hidden="true"
            />
          )}
          <InboxFacetsSidebar
            facets={facets}
            activeFilters={facetFilters}
            onChange={handleFacetFiltersChange}
            open={sidebarOpenMobile ? true : false}
            onClose={() => setSidebarOpenMobile(false)}
            collapsedSections={collapsedSections}
            onToggleSection={handleToggleFacetSection}
            loading={facetsLoading}
          />
        </>
      )}

      <div className="flex-1 space-y-6 min-w-0">
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {inboxView === 'spam' ? 'Spam / Junk' : inboxView === 'newsletter' ? 'Newsletters' : 'Unified Inbox'}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {inboxView === 'spam'
              ? 'Messages automatically filtered as spam or junk'
              : inboxView === 'newsletter'
              ? 'Newsletters, marketing emails, and automated notifications'
              : 'All pending messages across channels in one place'}
          </p>
        </div>
        {inboxView === 'inbox' && (
          <button
            type="button"
            onClick={() => setSidebarOpenMobile(true)}
            className="md:hidden inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            aria-label="Open filters"
          >
            <Filter size={14} />
            Filters
            {(() => {
              const n = Object.values(facetFilters).filter(Boolean).length
              return n > 0 ? <span className="rounded-full bg-teal-600 text-white px-2 py-0.5 text-xs">{n}</span> : null
            })()}
          </button>
        )}
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

      {/* Inbox / Newsletter / Spam toggle */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => { setInboxView('inbox'); setSelectedItem(null) }}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            inboxView === 'inbox' ? 'bg-teal-600 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          <Inbox className="h-4 w-4" />
          Inbox
        </button>
        <button
          onClick={() => { setInboxView('newsletter'); setSelectedItem(null) }}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            inboxView === 'newsletter' ? 'bg-amber-500 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          <Mail className="h-4 w-4" />
          Newsletter
          {newsletterCount > 0 && (
            <span className="rounded-full bg-amber-200 text-amber-800 px-2 py-0.5 text-xs font-semibold">{newsletterCount}</span>
          )}
        </button>
        <button
          onClick={() => { setInboxView('spam'); setSelectedItem(null) }}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            inboxView === 'spam' ? 'bg-red-500 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          <ShieldAlert className="h-4 w-4" />
          Spam
          {spamCount > 0 && (
            <span className="rounded-full bg-red-200 text-red-800 px-2 py-0.5 text-xs font-semibold">{spamCount}</span>
          )}
        </button>
      </div>

      {/* Active saved-view chip + quick "Save as view" CTA */}
      {inboxView === 'inbox' && (activeView || (hasNonDefaultFilters && !viewParam)) && (
        <div className="flex flex-wrap items-center gap-2">
          {activeView && (() => {
            const SVIcon = getSavedViewIcon(activeView.icon)
            return (
              <span className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-sm font-medium text-teal-800">
                <SVIcon className="h-3.5 w-3.5" />
                Viewing: {activeView.name}
                <button
                  onClick={clearActiveView}
                  className="ml-1 rounded-full p-0.5 text-teal-600 hover:bg-teal-100 hover:text-teal-900 transition-colors"
                  title="Clear view"
                  aria-label="Clear active saved view"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => { setEditingView(activeView); setShowSaveViewModal(true) }}
                  className="rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-teal-700 hover:bg-teal-100 transition-colors"
                  title="Edit view"
                >
                  Edit
                </button>
              </span>
            )
          })()}
          {!activeView && hasNonDefaultFilters && (
            <button
              onClick={() => { setEditingView(null); setShowSaveViewModal(true) }}
              className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:border-teal-300 hover:bg-teal-50 hover:text-teal-700 transition-colors"
              title="Save current filters as a saved view"
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
              Save as view
            </button>
          )}
        </div>
      )}

      {/* Filters */}
      {inboxView === 'inbox' && (
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
        <button
          onClick={() => setShowSnoozed((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
            showSnoozed
              ? 'bg-amber-500 text-white shadow-sm'
              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 hover:border-amber-300 hover:text-amber-700'
          }`}
          title={showSnoozed ? 'Hide snoozed conversations' : 'Show snoozed conversations alongside your inbox'}
        >
          <Clock size={14} />
          {showSnoozed ? 'Hide snoozed' : 'Show snoozed'}
        </button>
        <button
          onClick={() => { setEditingView(null); setShowSaveViewModal(true) }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 hover:border-teal-300 hover:bg-teal-50 hover:text-teal-700 transition-colors whitespace-nowrap"
          title="Save current filters as a view"
        >
          <Bookmark size={14} />
          <span className="hidden sm:inline">Save view</span>
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
            <button
              onClick={() => handleViewModeChange('kanban')}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === 'kanban'
                  ? 'bg-teal-600 text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
              title="Kanban board"
            >
              <LayoutGrid size={14} />
              Board
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Sync — manually fire IMAP/Graph pollers. Shows last sync time. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleSync}
            disabled={syncing}
            title={lastSyncAt ? `Last synced ${lastSyncAt.toLocaleTimeString()}` : 'Sync now'}
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync'}
          </Button>
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
            onClick={async () => {
              const ids = selectedIds.size > 0
                ? filteredItems.filter(i => selectedIds.has(i.id)).map(i => i.conversation_id)
                : []
              if (ids.length === 0) { toast.warning('Select messages first'); return }
              const supabase = createClient()
              // Assign to current user
              const { data: { user } } = await supabase.auth.getUser()
              if (!user) return
              const { error } = await supabase
                .from('conversations')
                .update({ assigned_to: user.id })
                .in('id', ids)
              if (error) toast.error('Failed to assign')
              else { toast.success(`Assigned ${ids.length} conversation(s) to you`); clearSelection() }
            }}
          >
            <UserPlus className="h-4 w-4" />
            Assign to Me
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const messageIds = selectedIds.size > 0
                ? filteredItems.filter((item) => selectedIds.has(item.id)).map((item) => item.message_id)
                : filteredItems.filter((item) => item.ai_status !== 'auto_sent').map((item) => item.message_id)
              if (messageIds.length === 0) {
                toast.warning('No pending messages to mark.')
                return
              }
              setConfirmAction({ type: 'mark_replied', count: messageIds.length })
            }}
          >
            <CheckCheck className="h-4 w-4" />
            Mark Replied
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
              {confirmAction.type === 'mark_replied' &&
                `Mark ${confirmAction.count} message${confirmAction.count > 1 ? 's' : ''} as replied? Use this if you replied from Gmail directly.`}
              {confirmAction.type === 'resolve' &&
                `Resolve the conversation${confirmAction.count > 1 ? 's' : ''} for ${confirmAction.count} selected message${confirmAction.count > 1 ? 's' : ''}? The conversation status will change to "resolved" and the messages will be marked replied.`}
              {confirmAction.type === 'assign_me' &&
                `Assign the conversation${confirmAction.count > 1 ? 's' : ''} for ${confirmAction.count} selected message${confirmAction.count > 1 ? 's' : ''} to you?`}
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
                variant={confirmAction.type === 'archive' ? 'danger' : confirmAction.type === 'mark_replied' ? 'success' : 'primary'}
                size="sm"
                loading={bulkActionLoading}
                onClick={async () => {
                  setBulkActionLoading(true)
                  try {
                    switch (confirmAction.type) {
                      case 'smart-approve':  await handleSmartApprove(); break
                      case 'approve':        await handleApproveSelected(); break
                      case 'mark_replied':   await handleMarkRepliedBulk(); break
                      case 'resolve':        await handleResolveBulk(); break
                      case 'assign_me':      await handleAssignMeBulk(); break
                      case 'archive':        await handleArchiveBulk(); break
                    }
                  } finally {
                    setBulkActionLoading(false)
                    setConfirmAction(null)
                  }
                }}
              >
                {confirmAction.type === 'archive' ? 'Archive'
                  : confirmAction.type === 'mark_replied' ? 'Mark Replied'
                  : confirmAction.type === 'resolve' ? 'Resolve'
                  : confirmAction.type === 'assign_me' ? 'Assign to me'
                  : 'Approve'}
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
              variant="primary"
              size="sm"
              onClick={() => {
                setConfirmAction({ type: 'mark_replied', count: selectedIds.size })
              }}
            >
              <CheckCheck className="h-4 w-4" />
              <span className="hidden sm:inline">Mark Replied</span>
              <span className="sm:hidden">Replied</span>
            </Button>
            <Button
              variant="success"
              size="sm"
              onClick={() => {
                setConfirmAction({ type: 'resolve', count: selectedIds.size })
              }}
            >
              <CircleCheck className="h-4 w-4" />
              <span className="hidden sm:inline">Resolve</span>
              <span className="sm:hidden">Resolve</span>
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
              onClick={() => {
                if (!currentUserId) {
                  toast.error('Not signed in.')
                  return
                }
                setConfirmAction({ type: 'assign_me', count: selectedIds.size })
              }}
            >
              <UserPlus className="h-4 w-4" />
              <span className="hidden sm:inline">Assign to me</span>
              <span className="sm:hidden">Assign</span>
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

      {/* Loading state — skeleton rows matching the inbox list shape */}
      {loading && (
        <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
          {Array.from({ length: 8 }).map((_, i) => (
            <InboxRowSkeleton key={i} />
          ))}
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
        <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
          {inboxView === 'spam' ? (
            <EmptyState
              icon={ShieldCheck}
              title="No spam messages"
              description="Your inbox is clean — no messages have been flagged as spam."
            />
          ) : inboxView === 'newsletter' ? (
            <EmptyState
              icon={Mail}
              title="No newsletters"
              description="No newsletters or marketing emails have been received."
            />
          ) : (
            <EmptyState
              icon={Inbox}
              title="All caught up!"
              description="Messages will appear here once your channels start receiving them."
              action={
                <Button variant="primary" onClick={handleSync} loading={syncing}>
                  <RefreshCw className="h-4 w-4" />
                  Sync
                </Button>
              }
              hint="Tip: click Sync to pull new mail from your connected accounts."
            />
          )}
        </div>
      )}

      {/* Filtered empty state */}
      {!loading && !error && items.length > 0 && filteredItems.length === 0 && inboxView === 'inbox' && (
        <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
          <EmptyState
            icon={Inbox}
            title="No messages match your filters"
            description="Try adjusting your filters or check back later."
          />
        </div>
      )}

      {/* Spam / Newsletter list */}
      {!loading && !error && inboxView !== 'inbox' && items.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              <span className="font-semibold text-gray-900">{items.length}</span>{' '}
              {inboxView === 'newsletter' ? 'newsletter' : 'spam'} message{items.length !== 1 ? 's' : ''}
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
              <Link
                key={item.id}
                href={`/conversations/${item.conversation_id}`}
                className="flex items-start gap-4 px-4 py-3 hover:bg-gray-50 transition-colors group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 truncate group-hover:text-teal-700">
                      {item.sender_name || 'Unknown'}
                    </span>
                    <span className="text-xs text-gray-400">
                      {item.channel}
                    </span>
                  </div>
                  <p className="text-sm text-gray-800 font-medium truncate mt-0.5">
                    {item.subject_or_preview || '(no subject)'}
                  </p>
                  {item.body_preview && (
                    <p className="text-xs text-gray-500 mt-1 line-clamp-2 leading-relaxed">
                      {item.body_preview}
                    </p>
                  )}
                  {item.spam_reason && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <ShieldAlert className="h-3.5 w-3.5 text-orange-500 flex-shrink-0" />
                      <span className="text-xs text-orange-600">{item.spam_reason}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 pt-0.5">
                  <span className="text-xs text-gray-400 whitespace-nowrap">
                    {getRelativeTime(item.time_waiting)}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      handleMarkNotSpam(item.message_id)
                    }}
                  >
                    Not Spam
                  </Button>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Inbox list */}
      {!loading && !error && inboxView === 'inbox' && filteredItems.length > 0 && viewMode === 'list' && (
        <InboxList
          items={filteredItems}
          selectedIds={selectedIds}
          onSelectionChange={handleSelectionChange}
        />
      )}

      {/* Split view — on mobile (<md) collapses to single-pane: list shown
          until a row is tapped, then preview swaps in with a Back button */}
      {!loading && !error && inboxView === 'inbox' && filteredItems.length > 0 && viewMode === 'split' && (
        <div className="flex flex-col md:flex-row rounded-lg border border-gray-200 bg-white overflow-hidden" style={{ height: 'calc(100vh - 320px)' }}>
          {/* Left: message list — hidden on mobile when an item is selected */}
          <div className={`md:w-[45%] md:shrink-0 overflow-y-auto md:border-r md:border-gray-200 ${selectedItem ? 'hidden md:block' : 'block'} flex-1 md:flex-initial`}>
            <InboxList
              items={filteredItems}
              onItemClick={handleItemClick}
              selectedItemId={selectedItem?.id || null}
              selectedIds={selectedIds}
              onSelectionChange={handleSelectionChange}
            />
          </div>

          {/* Right: conversation preview — hidden on mobile when no selection */}
          <div className={`flex-1 overflow-hidden bg-gray-50 ${selectedItem ? 'flex flex-col' : 'hidden md:flex md:flex-col'}`}>
            {selectedItem ? (
              <>
                {/* Mobile back button */}
                <button
                  type="button"
                  onClick={() => setSelectedItem(null)}
                  className="md:hidden flex items-center gap-2 border-b border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 min-h-[44px]"
                  aria-label="Back to list"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back to list
                </button>
                <div className="flex-1 overflow-hidden">
                  <InboxPreview item={selectedItem} />
                </div>
              </>
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

      {/* Kanban board view */}
      {!loading && !error && inboxView === 'inbox' && filteredItems.length > 0 && viewMode === 'kanban' && (
        <InboxKanban items={filteredItems} />
      )}

      {/* Load More button */}
      {!loading && !error && hasMore && (
        <div className="flex justify-center py-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={loadMore}
            disabled={loadingMore}
            className="px-6"
          >
            {loadingMore ? <Loader2 size={14} className="animate-spin" /> : null}
            {loadingMore ? 'Loading...' : `Load More (showing ${items.length})`}
          </Button>
        </div>
      )}

      {/* Save view modal — opens for create OR edit (when editingView set) */}
      <SavedViewModal
        open={showSaveViewModal}
        onClose={() => { setShowSaveViewModal(false); setEditingView(null) }}
        view={editingView}
        initialFilters={editingView ? undefined : currentFiltersAsView()}
        onSaved={(saved) => {
          // Notify the sidebar to refresh its list.
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('saved-views:changed'))
          }
          // If we just edited the active view, update it in place.
          if (activeView && saved.id === activeView.id) {
            setActiveView(saved)
          }
        }}
      />
      </div>
    </div>
  )
}
