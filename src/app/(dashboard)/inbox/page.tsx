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
import { CHANNELS, CHANNEL_KEYS, isChannel } from '@/lib/channels/registry'
import { decodeHtmlEntities } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { useRealtimeMessages } from '@/hooks/useRealtimeMessages'
import { isUnread } from '@/hooks/useReadStatus'
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

// Empty-state teaser derived from the channel registry (first few labels +
// "and more") so the copy never goes stale as channels are added.
const CHANNEL_TEASER = `${CHANNEL_KEYS.slice(0, 4).map((key) => CHANNELS[key].label).join(', ')} and more`

// InboxItem plus the assignee's display name (joined via conversations →
// users in this page's queries). Kept off the shared type so other InboxItem
// producers don't have to supply it; InboxRow reads it as an optional field.
type InboxItemWithAssignee = InboxItem & { assigned_to_name?: string | null }

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

/**
 * Run an async op over a list of ids with bounded concurrency, partitioning
 * them into the ones that succeeded and the ones that failed. The bulk inbox
 * actions use this to fan each mutation out across the guarded per-conversation
 * API routes (one request per conversation) instead of a single direct client
 * write — so the server-side RBAC / channel gates and audit/CSAT/webhook
 * side-effects run for every row. `op` resolves true on success, false on a
 * handled failure (e.g. a 403); a thrown error is treated as a failure too.
 */
async function runBatch<T>(
  ids: T[],
  op: (id: T) => Promise<boolean>,
  concurrency = 6
): Promise<{ succeeded: T[]; failed: T[] }> {
  const succeeded: T[] = []
  const failed: T[] = []
  let cursor = 0
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++]
      try {
        if (await op(id)) succeeded.push(id)
        else failed.push(id)
      } catch {
        failed.push(id)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, worker)
  )
  return { succeeded, failed }
}

/** POST helper for the guarded conversation routes. Resolves true on 2xx. */
async function postConversationAction(
  conversationId: string,
  path: string,
  body: Record<string, unknown>
): Promise<boolean> {
  const res = await fetch(`/api/conversations/${conversationId}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.ok
}

export default function InboxPage() {
  const { isAdmin, account_id: userAccountId, companyAccountIds, activeCompanyId, permissions, can } = useUser()
  // RBAC gates for the bulk write actions. Defense-in-depth — the server-side
  // routes (status / assign / mark-replied) are the real enforcement, but we
  // also disable the buttons so a restricted user isn't offered an action that
  // will only 403. `can()` returns true when no permission set is present
  // (provider outside the dashboard), so this never blanks the controls.
  const canSend = can('action:message.send')
  const canAssign = can('action:conversation.assign')
  const { toast } = useToast()
  const searchParams = useSearchParams()
  // RBAC channel visibility: the channels this user may see. When no permission
  // set is present (provider outside the dashboard), treat as unrestricted so we
  // never blank the inbox.
  const allowedChannels = useMemo(
    () => (permissions.length === 0 ? CHANNEL_KEYS : CHANNEL_KEYS.filter((c) => permissions.includes(`channel:${c}`))),
    [permissions]
  )
  const channelRestricted = allowedChannels.length < CHANNEL_KEYS.length
  const [filters, setFilters] = useState<InboxFilters>(() => {
    // Initialize filters from URL search params if present
    if (typeof window === 'undefined') return defaultFilters
    const params = new URLSearchParams(window.location.search)
    const channel = params.get('channel')
    const category = params.get('category')
    const sentiment = params.get('sentiment')
    return {
      channel: (channel && isChannel(channel) ? channel : 'all') as InboxFilters['channel'],
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
  // Split loading state: skeletons only while we have nothing to show for the
  // CURRENT query (first load or a view/filter change). Refetches of the same
  // query (realtime nudge, banner click, retry) keep the stale list rendered
  // and only flip `refreshing`, so background refreshes don't blank the list.
  const [initialLoading, setInitialLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // Query identity of the last fetch that returned data — a match means the
  // next fetch is a background refresh of what's already on screen.
  const fetchedQueryKeyRef = useRef<string | null>(null)
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
  // Inbox count = total non-spam inbound messages. Mirrors the spam/newsletter
  // count queries below so all three tabs show a badge consistently (#5.7).
  const [inboxCount, setInboxCount] = useState(0)
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

  // Optimistic list mutations for InboxList → InboxRow (hover actions + the
  // keyboard `e` archive). Keyed by `message_id` — the same key the bulk
  // handlers and Supabase writes use. Mirrors the existing setItems filter
  // pattern so a row leaves / updates immediately instead of waiting for a
  // refetch.
  const handleItemRemoved = useCallback((messageId: string) => {
    // Resolve the removed row's `id` from the SAME snapshot we filter, so a
    // concurrent realtime refetch can't make the selection-prune read a stale
    // `items` closure. Selection keys off `id`, removal off `message_id`.
    let removedId: string | undefined
    setItems((prev) => {
      removedId = prev.find((it) => it.message_id === messageId)?.id
      return prev.filter((item) => item.message_id !== messageId)
    })
    setSelectedIds((prev) => {
      if (!removedId || !prev.has(removedId)) return prev
      const next = new Set(prev)
      next.delete(removedId)
      return next
    })
  }, [])

  const handleItemUpdated = useCallback((messageId: string, patch: Partial<InboxItem>) => {
    setItems((prev) =>
      prev.map((item) => (item.message_id === messageId ? { ...item, ...patch } : item))
    )
  }, [])

  // Mirrors loadingMore for non-reactive readers: a background refresh and
  // Load More both full-replace the list, so they must never interleave.
  const loadingMoreRef = useRef(false)

  // ── Server-side filter plan ───────────────────────────────────────────
  // Previously every predicate below (status, assignee, unread, category,
  // sentiment, priority, free-text search) ran client-side as an array
  // `.filter()` over ONLY the 50 loaded messages, so a matching conversation
  // that hadn't paged in was silently missed. We now push the DB-expressible
  // predicates into the supabase query (additive to tenant scope + RBAC) so
  // they apply across the FULL dataset. Two predicates stay client-side and
  // are documented at `filteredItems` (snooze: trivial, derived from now;
  // unread_only: per-device localStorage, not a DB column).
  //
  // `inboxFilterPlan` collects everything the list/loadMore queries need to
  // reproduce identical filtering. It folds together the three filter sources
  // that used to be applied separately client-side:
  //   1. InboxFiltersBar    → filters.{channel,category,sentiment,priority,search}
  //   2. scope toggle        → myConversationsOnly
  //   3. facets sidebar      → facetFilters.{urgency,status,assignment}
  //   4. active saved view   → activeView.filters.{status,assignee,account_ids,age_hours_gt}
  // When two sources set the same dimension (e.g. sidebar status + saved-view
  // status) we AND them, matching the old client-side behaviour where each
  // independent `if` had to pass.
  const inboxFilterPlan = useMemo(() => {
    const view = activeView?.filters ?? {}
    const search = filters.search.trim()

    // category / sentiment / urgency live on message_classifications (a
    // one-row-per-message child). A non-null filter on any of them forces an
    // inner join so unmatched messages drop out server-side.
    const category = filters.category !== 'all' ? (filters.category as string) : null
    const sentiment = filters.sentiment !== 'all' ? (filters.sentiment as string) : null
    // Urgency comes from the facets sidebar AND, indirectly, from the priority
    // dropdown — priority is DERIVED from urgency via derivePriority(). The map
    // is 1:1 for urgent/high/medium, but priority 'low' folds together urgency
    // 'low' + NULL + any unknown value, which isn't a single `.eq`. So:
    //   • priority urgent/high/medium → urgency .eq(same)
    //   • priority low                → handled client-side (kept in filteredItems).
    //     KNOWN LIMITATION: 'low' folds urgency low + NULL + unknown, which is
    //     neither a single server `.eq` nor expressible as an embed filter without
    //     an inner join that would drop the unclassified (=low) rows. So "show
    //     only low" filters the LOADED page, not the full dataset, and can miss
    //     low-priority conversations not yet paged in. Accepted: low is the
    //     catch-all bucket; the actionable priorities span the full dataset.
    let urgency = facetFilters.urgency ?? null
    if (!urgency && filters.priority !== 'all' && filters.priority !== 'low') {
      urgency = filters.priority
    }
    const classificationInner = !!(category || sentiment || urgency)

    // conversation-level predicates (status / assignment / snooze / merged).
    // `conversations` is made an inner join unconditionally (every stored
    // message has one) so we can also push merged_into_id IS NULL down.
    const status = facetFilters.status ?? (view.status && view.status !== 'all' ? view.status : null)

    // Assignment: scope toggle (myConversationsOnly) AND sidebar AND saved-view
    // can each constrain it. They never conflict in practice (all resolve to
    // me / unassigned / a specific user); if both 'me' and a user id were set
    // we honour the most specific. Resolve to a concrete server predicate.
    let assignedTo: string | null = null // a specific user_id to match
    let assignedToMe = false
    let unassigned = false
    if (myConversationsOnly) assignedToMe = true
    if (facetFilters.assignment === 'me') assignedToMe = true
    else if (facetFilters.assignment === 'unassigned') unassigned = true
    if (view.assignee && view.assignee !== 'all') {
      if (view.assignee === 'me') assignedToMe = true
      else if (view.assignee === 'unassigned') unassigned = true
      else assignedTo = view.assignee
    }
    // assignedToMe needs the current user id; resolved at query time.

    // saved-view account scoping (intersected with tenant scope by the caller).
    const accountIds = Array.isArray(view.account_ids) && view.account_ids.length > 0
      ? view.account_ids
      : null

    // saved-view age filter: only rows older than N hours.
    const ageCutoffIso = view.age_hours_gt && view.age_hours_gt > 0
      ? new Date(Date.now() - view.age_hours_gt * 36e5).toISOString()
      : null

    return {
      search: search || null,
      category,
      sentiment,
      urgency,
      classificationInner,
      status,
      assignedTo,
      assignedToMe,
      unassigned,
      accountIds,
      ageCutoffIso,
    }
  }, [filters.category, filters.sentiment, filters.priority, filters.search, facetFilters.urgency, facetFilters.status, facetFilters.assignment, myConversationsOnly, activeView])

  // Stable string key of the plan — drives query identity so a filter change is
  // treated as a NEW query (skeletons) rather than a background refresh.
  const inboxFilterKey = useMemo(
    () => JSON.stringify(inboxFilterPlan) + '|' + (currentUserId ?? ''),
    [inboxFilterPlan, currentUserId]
  )

  // The select string toggles message_classifications between a left join and
  // an inner join depending on whether a classification predicate is active —
  // an unconditional inner join would silently drop unclassified messages.
  const inboxSelect = useMemo(() => {
    const mc = inboxFilterPlan.classificationInner
      ? 'message_classifications!inner ( category, sentiment, urgency, confidence, classified_at )'
      : 'message_classifications ( category, sentiment, urgency, confidence, classified_at )'
    return `
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
          ${mc},
          ai_replies ( status, created_at ),
          conversations!messages_conversation_id_fkey!inner ( status, assigned_to, tags, snoozed_until, merged_into_id, assigned:users!conversations_assigned_to_fkey ( full_name ) )
        `
  }, [inboxFilterPlan.classificationInner])

  // Apply the server-side filter plan to a messages query. Additive only — the
  // caller has already applied tenant scope, RBAC channel scope, the spam/view
  // filter, and (for loadMore) the keyset cursor. Returns the augmented query.
  // Typed loosely because `.select(<dynamic string>)` already erases the row
  // type to `any` upstream, so a precise generic would add fragility (the
  // builder threads `this`) for no real safety here — matching the file's
  // existing `msg: any` convention for these PostgREST chains.
  const applyInboxFilters = useCallback((query: any): any => {
    const p = inboxFilterPlan
    let q = query

    // ── message_classifications predicates (embedded one-to-many; inner-joined
    //    via inboxSelect when any of these are set) ──
    if (p.category) q = q.eq('message_classifications.category', p.category)
    if (p.sentiment) q = q.eq('message_classifications.sentiment', p.sentiment)
    if (p.urgency) q = q.eq('message_classifications.urgency', p.urgency)

    // ── conversation predicates (conversations is inner-joined in inboxSelect) ──
    // Drop merged-away conversations server-side (was a client-side post-filter).
    q = q.is('conversations.merged_into_id', null)
    if (p.status) q = q.eq('conversations.status', p.status)
    if (p.assignedTo) q = q.eq('conversations.assigned_to', p.assignedTo)
    else if (p.assignedToMe && currentUserId) q = q.eq('conversations.assigned_to', currentUserId)
    else if (p.unassigned) q = q.is('conversations.assigned_to', null)
    // NOTE: the snooze hide-filter stays CLIENT-SIDE (see filteredItems). It's a
    // trivial derived "snoozed_until > now" check that would need a SECOND
    // referenced-table `.or()` alongside the search `.or()` below; snoozed rows
    // are low-volume, so keeping it client-side avoids that fragility with no
    // practical paging impact.

    // ── message-level predicates ──
    if (p.accountIds) q = q.in('account_id', p.accountIds)
    if (p.ageCutoffIso) q = q.lt('received_at', p.ageCutoffIso)

    // ── free-text search ── matches sender, email subject, and body across the
    // FULL dataset (was a client-side substring test over loaded rows only).
    // BEHAVIOR CHANGE: the old client-side search ALSO matched account_name
    // (the tenant/account label). That column lives on the joined `accounts`
    // row and PostgREST can't OR a root column together with an embedded-table
    // column in one .or(), so account-name matching is DROPPED — and it can't
    // be recovered client-side either, since rows that match ONLY on account
    // name are never fetched by this query. Sender/subject/body cover the
    // overwhelming majority of searches and now span every page (the goal).
    // Input is escaped so a comma/paren/wildcard in the term can't break the
    // .or() grammar or act as an unintended ilike wildcard.
    if (p.search) {
      const esc = p.search.replace(/([%_,()\\])/g, '\\$1')
      q = q.or(`sender_name.ilike.%${esc}%,email_subject.ilike.%${esc}%,message_text.ilike.%${esc}%`)
    }

    return q
  }, [inboxFilterPlan, currentUserId])

  // Keyset pagination cursor: the LAST RAW message fetched (lowest received_at,
  // then lowest id as a deterministic tiebreaker) — NOT the collapsed row head.
  // loadMore continues strictly below this boundary so it (a) never skips rows
  // that share the boundary received_at, and (b) never re-fetches older messages
  // of on-screen conversations (which would inflate message_count).
  const cursorRef = useRef<{ receivedAt: string; id: string } | null>(null)
  // The account-id set fetchInboxItems actually used (after the /api/user-accounts
  // fallback). loadMore reuses it so pages 2+ are scoped identically to page 1.
  const resolvedAccountIdsRef = useRef<string[]>(companyAccountIds)

  const fetchInboxItems = useCallback(async () => {
    // Filter state is part of the query identity now (filters run server-side),
    // so changing any filter is a NEW query → skeletons, not a silent refresh.
    const queryKey = [inboxView, filters.channel, dashboardFilter ?? '', activeCompanyId ?? '', companyAccountIds.join(','), inboxFilterKey].join('|')
    const isBackgroundRefresh = fetchedQueryKeyRef.current === queryKey
    // Skip a background refresh while Load More is in flight — its page-1
    // replace would wipe the appended pages. The next realtime event (or any
    // user action) re-triggers the refresh, so nothing is lost for long.
    if (isBackgroundRefresh && loadingMoreRef.current) return
    if (isBackgroundRefresh) setRefreshing(true)
    else setInitialLoading(true)
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
      // Remember the resolved set so loadMore scopes pages 2+ identically.
      resolvedAccountIdsRef.current = resolvedAccountIds

      // Fetch inbound messages with joined data. The select string is dynamic:
      // message_classifications switches to an inner join when a category/
      // sentiment/urgency filter is active (so unmatched messages drop out);
      // conversations is always inner-joined so we can push merged/status/
      // assignee/snooze predicates down to the DB.
      let messagesQuery = supabase
        .from('messages')
        .select(inboxSelect)
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
        // id is the deterministic tiebreaker for equal received_at — required so
        // the keyset cursor (received_at, id) can page without skipping ties.
        .order('id', { ascending: false })
        .limit(INBOX_PAGE_SIZE)

      // Apply channel filter server-side (so Teams/Email/WhatsApp filter actually fetches correct data)
      if (filters.channel !== 'all') {
        messagesQuery = messagesQuery.eq('channel', filters.channel)
      }

      // Apply dashboard filter from URL params
      if (dashboardFilter === 'pending') {
        messagesQuery = messagesQuery.eq('reply_required', true).eq('replied', false)
      }

      // Scope to the active tenant's accounts (cookie-resolved in layout).
      // `activeCompanyId === null` is the super_admin combined view → run
      // unscoped. A real tenant with zero accounts passes `[]` here so the
      // query correctly returns no rows instead of falling through unscoped.
      if (activeCompanyId) {
        messagesQuery = messagesQuery.in('account_id', resolvedAccountIds)
      }

      // ── Apply the server-side filter plan ──
      // Only on the main inbox view — the spam/newsletter views render the raw
      // `items` list (no filter bar, no `filteredItems`) and must keep showing
      // ALL flagged messages regardless of the inbox filters. For those views
      // we still push merged_into_id IS NULL so they match the badge counts and
      // the old client-side `visibleMessages` drop.
      if (inboxView === 'inbox') {
        messagesQuery = applyInboxFilters(messagesQuery)
      } else {
        messagesQuery = messagesQuery.is('conversations.merged_into_id', null)
      }

      // Also fetch newsletter + spam counts for the badges. We inner-join
      // conversations and filter merged_into_id IS NULL so the badge totals
      // match the visible list (which drops merged conversations).
      // Tab badges count DISTINCT CONVERSATIONS, not messages. The list
      // collapses email down to one row per conversation, so a message-based
      // count (e.g. 177 newsletter messages) could never be reconciled with the
      // list's "27 of 27" conversations and looked like a bug. We fetch the
      // qualifying conversation_id rows and dedupe client-side (cheap at this
      // scale); the .limit guards against runaway result sets.
      let newsletterCountQuery = supabase
        .from('messages')
        .select('conversation_id, conversations!messages_conversation_id_fkey!inner(merged_into_id)')
        .eq('direction', 'inbound')
        .eq('is_spam', true)
        .in('spam_reason', ['newsletter', 'marketing', 'automated_notification', 'ai_classified_newsletter'])
        .is('conversations.merged_into_id', null)
        .limit(5000)
      if (activeCompanyId) {
        newsletterCountQuery = newsletterCountQuery.in('account_id', resolvedAccountIds)
      }

      let spamCountQuery = supabase
        .from('messages')
        .select('conversation_id, conversations!messages_conversation_id_fkey!inner(merged_into_id)')
        .eq('direction', 'inbound')
        .eq('is_spam', true)
        .not('spam_reason', 'in', '(newsletter,marketing,automated_notification,ai_classified_newsletter)')
        .is('conversations.merged_into_id', null)
        .limit(5000)
      if (activeCompanyId) {
        spamCountQuery = spamCountQuery.in('account_id', resolvedAccountIds)
      }

      // Inbox count = distinct conversations with inbound, non-spam messages.
      // Used to populate the badge on the "Inbox" tab so all three tabs show
      // counts consistently (#5.7).
      let inboxCountQuery = supabase
        .from('messages')
        .select('conversation_id, conversations!messages_conversation_id_fkey!inner(merged_into_id)')
        .eq('direction', 'inbound')
        .eq('is_spam', false)
        .is('conversations.merged_into_id', null)
        .limit(5000)
      if (activeCompanyId) {
        inboxCountQuery = inboxCountQuery.in('account_id', resolvedAccountIds)
      }

      // RBAC: hide channels this user can't access (skipped when unrestricted).
      if (channelRestricted) {
        messagesQuery = messagesQuery.in('channel', allowedChannels)
        newsletterCountQuery = newsletterCountQuery.in('channel', allowedChannels)
        spamCountQuery = spamCountQuery.in('channel', allowedChannels)
        inboxCountQuery = inboxCountQuery.in('channel', allowedChannels)
      }

      const [messagesResult, newsletterCountResult, spamCountResult, inboxCountResult] = await Promise.all([
        messagesQuery,
        newsletterCountQuery,
        spamCountQuery,
        inboxCountQuery,
      ])

      if (messagesResult.error) {
        throw messagesResult.error
      }

      // Dedupe conversation_id rows → distinct-conversation badge counts that
      // line up with the collapsed list.
      const distinctConvos = (rows: Array<{ conversation_id: string | null }> | null | undefined) =>
        new Set((rows ?? []).map((r) => r.conversation_id).filter(Boolean)).size
      setNewsletterCount(distinctConvos(newsletterCountResult.data as Array<{ conversation_id: string | null }> | null))
      setSpamCount(distinctConvos(spamCountResult.data as Array<{ conversation_id: string | null }> | null))
      setInboxCount(distinctConvos(inboxCountResult.data as Array<{ conversation_id: string | null }> | null))

      const data = messagesResult.data
      if (!data) {
        setItems([])
        fetchedQueryKeyRef.current = queryKey
        return
      }

      // Drop messages whose conversation has been merged into another (soft
      // merge — the secondary stays for audit but should not surface here).
      const visibleMessages = data.filter((msg: any) => {
        const conv = msg.conversations as { merged_into_id?: string | null } | null
        return !conv?.merged_into_id
      })

      const mapped: InboxItemWithAssignee[] = visibleMessages.map((msg: any) => {
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
          subject_or_preview: decodeHtmlEntities(msg.email_subject || msg.message_text || ''),
          body_preview: msg.message_text ? String(msg.message_text).replace(/\s+/g, ' ').trim().substring(0, 280) : null,
          category: classification?.category ?? null,
          sentiment: classification?.sentiment ?? null,
          urgency,
          time_waiting: msg.received_at ?? msg.timestamp ?? '',
          priority: derivePriority(urgency),
          ai_status: mapAiStatus(aiReply?.status, phase2Enabled),
          ai_confidence: classification?.confidence != null ? Math.round(Number(classification.confidence) * 100) : null,
          message_id: msg.id,
          conversation_id: msg.conversation_id,
          conversation_status: conversation?.status ?? null,
          assigned_to: conversation?.assigned_to ?? null,
          assigned_to_name: conversation?.assigned?.full_name ?? null,
          tags: conversation?.tags ?? null,
          timestamp: msg.received_at || msg.timestamp,
          is_spam: msg.is_spam ?? false,
          spam_reason: msg.spam_reason ?? null,
          snoozed_until: conversation?.snoozed_until ?? null,
        } satisfies InboxItemWithAssignee
      })

      // Collapse to ONE row per conversation (industry standard, like Gmail/
      // Front). Both Teams AND email are now grouped by conversation_id — we
      // keep the LATEST message per conversation (real `received_at` date) and
      // track how many messages it represents via `message_count`. WhatsApp and
      // any other channel are collapsed the same way. Previously only Teams was
      // collapsed and every email was pushed as its own row, which — combined
      // with sender-only threading — flooded the inbox with duplicate threads.
      const convMap = new Map<string, InboxItem>()
      const passthrough: InboxItem[] = []
      for (const item of mapped) {
        if (!item.conversation_id) {
          // No conversation id (shouldn't happen for stored messages) — keep as-is.
          passthrough.push(item)
          continue
        }
        const existing = convMap.get(item.conversation_id)
        if (!existing) {
          convMap.set(item.conversation_id, { ...item, message_count: 1 })
        } else {
          const count = (existing.message_count ?? 1) + 1
          // Keep whichever message is newest by real timestamp as the row head.
          const head =
            new Date(item.timestamp).getTime() > new Date(existing.timestamp).getTime()
              ? item
              : existing
          convMap.set(item.conversation_id, { ...head, message_count: count })
        }
      }
      const deduped: InboxItem[] = [...passthrough, ...convMap.values()]
      // Sort newest-activity first (real `received_at` now drives `timestamp`).
      deduped.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

      setItems(deduped)
      // "Load More" availability keys off the RAW message count, not the
      // collapsed row count — collapse can shrink 50 messages to far fewer
      // rows, which previously hid the button while more pages still existed.
      // (loadMore already used the raw `moreMessages.length` test; this aligns
      // the initial fetch with it.)
      setHasMore(data.length >= INBOX_PAGE_SIZE)
      // Keyset cursor = the LAST RAW message of this page (the true page
      // boundary by received_at,id), NOT the collapsed head — so loadMore
      // continues from the real message stream, not a conversation's newest msg.
      const lastRaw = data[data.length - 1] as any
      cursorRef.current = lastRaw ? { receivedAt: (lastRaw.received_at ?? lastRaw.timestamp) as string, id: lastRaw.id } : null
      setTotalCount(deduped.length)
      // Only a fetch that returned data marks the query as "on screen" — a
      // failed first load keeps skeletons (not a wrong empty state) on retry.
      fetchedQueryKeyRef.current = queryKey
    } catch (err: any) {
      console.error('Failed to fetch inbox items:', err)
      setError(err.message ?? 'Failed to load inbox messages')
    } finally {
      setInitialLoading(false)
      setRefreshing(false)
    }
  }, [isAdmin, companyAccountIds, activeCompanyId, inboxView, dashboardFilter, filters.channel, channelRestricted, allowedChannels, INBOX_PAGE_SIZE, inboxFilterKey, inboxSelect, applyInboxFilters])

  useEffect(() => {
    fetchInboxItems()
  }, [fetchInboxItems])

  // Load more messages (append to existing list)
  const loadMore = useCallback(async () => {
    // `refreshing` guard: a concurrent background refresh would replace the
    // list with page 1 and this append would then merge from a stale base.
    if (loadingMore || !hasMore || refreshing) return
    setLoadingMore(true)
    loadingMoreRef.current = true
    try {
      const supabase = createClient()
      // Compound keyset cursor from the previous page's last RAW message
      // (received_at, then id). A strict .lt on received_at alone would skip
      // rows sharing the exact boundary timestamp (they'd land on no page) and
      // re-fetch older messages of on-screen conversations (inflating
      // message_count). The (received_at, id) tuple walks the raw stream exactly
      // once. Timestamps are double-quoted so the +00:00 offset can't be
      // misparsed inside the .or() grammar. Same dynamic select + filter plan as
      // the initial fetch so the next page is filtered identically server-side.
      const cursor = cursorRef.current
      if (!cursor) return

      let moreQuery = supabase
        .from('messages')
        .select(inboxSelect)
        .eq('direction', 'inbound')
        .or(`received_at.lt."${cursor.receivedAt}",and(received_at.eq."${cursor.receivedAt}",id.lt.${cursor.id})`)
        .order('received_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(INBOX_PAGE_SIZE)

      if (inboxView === 'inbox') moreQuery = moreQuery.eq('is_spam', false)
      else if (inboxView === 'newsletter') moreQuery = moreQuery.eq('is_spam', true).in('spam_reason', ['newsletter', 'marketing', 'automated_notification', 'ai_classified_newsletter'])
      else moreQuery = moreQuery.eq('is_spam', true).not('spam_reason', 'in', '(newsletter,marketing,automated_notification,ai_classified_newsletter)')

      if (filters.channel !== 'all') moreQuery = moreQuery.eq('channel', filters.channel)
      if (channelRestricted) moreQuery = moreQuery.in('channel', allowedChannels)
      // Scope to the active tenant. `activeCompanyId === null` is super_admin
      // combined view → run unscoped. Zero-account tenants pass `[]` → no rows.
      if (activeCompanyId) moreQuery = moreQuery.in('account_id', resolvedAccountIdsRef.current)

      // Apply the server-side filter plan (inbox view only — mirrors fetchInboxItems).
      if (inboxView === 'inbox') moreQuery = applyInboxFilters(moreQuery)
      else moreQuery = moreQuery.is('conversations.merged_into_id', null)

      const { data: moreMessages } = await moreQuery

      if (moreMessages && moreMessages.length > 0) {
        // Advance the keyset cursor to this page's last RAW message (boundary).
        const lastRaw = moreMessages[moreMessages.length - 1] as any
        cursorRef.current = { receivedAt: (lastRaw.received_at ?? lastRaw.timestamp) as string, id: lastRaw.id }

        const visibleMore = moreMessages.filter((msg: any) => {
          const conv = msg.conversations as { merged_into_id?: string | null } | null
          return !conv?.merged_into_id
        })
        const mapped: InboxItemWithAssignee[] = visibleMore.map((msg: any) => {
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
            subject_or_preview: decodeHtmlEntities(msg.email_subject || msg.message_text?.substring(0, 100) || 'No preview'),
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
            assigned_to_name: conv?.assigned?.full_name ?? null,
            tags: conv?.tags || null,
            is_spam: msg.is_spam ?? false,
            spam_reason: msg.spam_reason ?? null,
            snoozed_until: conv?.snoozed_until ?? null,
          }
        })
        // Merge into the existing list, collapsing to one row per conversation
        // (same rule as the initial fetch). A newly-paged message that belongs
        // to a conversation already on screen bumps its message_count and, if
        // newer, becomes the row head — it does NOT add a duplicate row.
        const collapseMerge = (prev: InboxItem[]): InboxItem[] => {
          const byConv = new Map<string, InboxItem>()
          const loose: InboxItem[] = []
          for (const it of [...prev, ...mapped]) {
            if (!it.conversation_id) { loose.push(it); continue }
            const ex = byConv.get(it.conversation_id)
            if (!ex) {
              byConv.set(it.conversation_id, { ...it, message_count: it.message_count ?? 1 })
            } else {
              const count = (ex.message_count ?? 1) + (it.message_count ?? 1)
              const head =
                new Date(it.timestamp).getTime() > new Date(ex.timestamp).getTime() ? it : ex
              byConv.set(it.conversation_id, { ...head, message_count: count })
            }
          }
          const merged = [...loose, ...byConv.values()]
          merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          return merged
        }
        const mergedItems = collapseMerge(items)
        setItems(mergedItems)
        // Keep the count badge in sync with the collapsed row count.
        setTotalCount(mergedItems.length)
        setHasMore(moreMessages.length >= INBOX_PAGE_SIZE)
      } else {
        setHasMore(false)
      }
    } catch (err) {
      console.error('Failed to load more:', err)
    } finally {
      setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }, [items, loadingMore, hasMore, refreshing, companyAccountIds, activeCompanyId, inboxView, filters.channel, channelRestricted, allowedChannels, INBOX_PAGE_SIZE, inboxSelect, applyInboxFilters])

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
    // Scope realtime to the active tenant. `undefined` = combined view
    // (super_admin) → subscribe to every account.
    accountIds: activeCompanyId ? companyAccountIds : undefined,
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

  // ── Client-side residue filter ────────────────────────────────────────
  // MOST predicates now run server-side in `applyInboxFilters` (status,
  // assignee, category, sentiment, urgency, most of priority, free-text search,
  // saved-view account_ids/age, merged-drop) so they apply across the FULL
  // dataset rather than the loaded page. Only three predicates remain here, and
  // ONLY because they can't be expressed cleanly/safely in the DB query:
  //
  //   1. Snooze hide — a trivial derived "snoozed_until > now" comparison.
  //      Kept client-side to avoid a second referenced-table `.or()` next to
  //      the search `.or()`; snoozed rows are low-volume so paging is unaffected.
  //   2. priority === 'low' — priority is DERIVED from urgency, and 'low' folds
  //      together urgency low/NULL/unknown, which isn't a single `.eq`. The
  //      other priorities (urgent/high/medium) ARE pushed server-side.
  //   3. unread_only (saved view) — "unread" is per-DEVICE localStorage
  //      (useReadStatus), not a DB column, so it can only be computed here.
  const filteredItems = useMemo(() => {
    const viewFilters = activeView?.filters ?? {}
    const nowMs = Date.now()
    const lowPriorityOnly = filters.priority === 'low'
    return items.filter((item) => {
      if (!showSnoozed && item.snoozed_until && new Date(item.snoozed_until).getTime() > nowMs) {
        return false
      }
      // priority 'low' is the one priority value not pushed to the server.
      if (lowPriorityOnly && item.priority !== 'low') return false
      // Unread-only: latest activity newer than the last time THIS device opened
      // the conversation (per-device localStorage via isUnread).
      if (viewFilters.unread_only && !isUnread(item.conversation_id, item.timestamp)) return false
      return true
    })
  }, [items, filters.priority, activeView, showSnoozed])

  // ─── Bulk-action handlers ────────────────────────────────────────────
  // Each handler fans its operation out across the guarded per-conversation
  // API routes — one request per selected conversation via `runBatch` — rather
  // than writing the conversations/messages tables directly from the browser.
  // This routes every mutation through the server-side RBAC / channel gates
  // (and the audit / CSAT / webhook side-effects) those routes enforce. We then
  // compare the count that actually succeeded to the count requested and
  // surface a partial-success warning via `reportPartial` instead of silently
  // claiming "all succeeded" (e.g. when the server returns 403 for some rows).

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
    if (selectedIds.size === 0) {
      toast.warning('Select messages first.')
      return
    }
    const convIds = selectedConversationIds()
    if (convIds.length === 0) {
      toast.warning('Nothing to mark.')
      return
    }
    // One guarded request per conversation (POST .../mark-replied) instead of a
    // direct `messages` write — enforces action:message.send server-side and
    // records an audit entry. Optimistic removal is reconciled against the set
    // that actually succeeded.
    const { succeeded } = await runBatch(convIds, (cid) =>
      postConversationAction(cid, 'mark-replied', {})
    )
    if (succeeded.length > 0) {
      const okSet = new Set(succeeded)
      setItems((prev) => prev.filter((item) => !okSet.has(item.conversation_id)))
      clearSelection()
    }
    reportPartial(convIds.length, succeeded.length, 'mark replied')
  }, [selectedIds, selectedConversationIds, toast, clearSelection, reportPartial])

  const handleResolveBulk = useCallback(async () => {
    const convIds = selectedConversationIds()
    if (convIds.length === 0) {
      toast.warning('Nothing to resolve.')
      return
    }
    // Per conversation: flip status→resolved through the guarded /status route
    // (which also fires CSAT + the conversation.resolved webhook + audit), then
    // best-effort clear reply_required via /mark-replied so a resolved thread
    // leaves the pending / SLA pipeline. A conversation counts as resolved only
    // when the status call itself succeeds.
    const { succeeded } = await runBatch(convIds, async (cid) => {
      const ok = await postConversationAction(cid, 'status', { status: 'resolved' })
      if (!ok) return false
      await postConversationAction(cid, 'mark-replied', {}).catch(() => false)
      return true
    })
    if (succeeded.length > 0) {
      const okSet = new Set(succeeded)
      setItems((prev) => prev.filter((item) => !okSet.has(item.conversation_id)))
      clearSelection()
    }
    reportPartial(convIds.length, succeeded.length, 'resolve')
  }, [selectedConversationIds, toast, clearSelection, reportPartial])

  const handleAssignMeBulk = useCallback(async () => {
    if (!currentUserId) {
      toast.error('Not signed in.')
      return
    }
    const convIds = selectedConversationIds()
    if (convIds.length === 0) {
      toast.warning('Nothing to assign.')
      return
    }
    // One guarded request per conversation (POST .../assign, self-assign) —
    // enforces action:conversation.assign server-side and writes an audit
    // entry. Self-assign always passes the route's supervisor-tier check.
    const { succeeded } = await runBatch(convIds, (cid) =>
      postConversationAction(cid, 'assign', { user_id: currentUserId })
    )
    reportPartial(convIds.length, succeeded.length, 'assign')
    if (succeeded.length > 0) {
      clearSelection()
      fetchInboxItems()
    }
  }, [currentUserId, selectedConversationIds, toast, clearSelection, fetchInboxItems, reportPartial])

  const handleArchiveBulk = useCallback(async () => {
    if (selectedIds.size === 0) {
      toast.warning('Select messages first.')
      return
    }
    const convIds = selectedConversationIds()
    if (convIds.length === 0) {
      toast.warning('Nothing to archive.')
      return
    }
    // One guarded request per conversation (POST .../mark-replied) instead of a
    // direct `messages` write — enforces action:message.send server-side. When
    // archiving from the spam/newsletter views, clear_spam also flips is_spam
    // off so the thread doesn't reappear there.
    const clearSpam = inboxView !== 'inbox'
    const { succeeded } = await runBatch(convIds, (cid) =>
      postConversationAction(cid, 'mark-replied', { clear_spam: clearSpam })
    )
    if (succeeded.length > 0) {
      const okSet = new Set(succeeded)
      setItems((prev) => prev.filter((item) => !okSet.has(item.conversation_id)))
      if (inboxView === 'newsletter') {
        setNewsletterCount((prev) => Math.max(0, prev - succeeded.length))
      } else if (inboxView === 'spam') {
        setSpamCount((prev) => Math.max(0, prev - succeeded.length))
      }
      clearSelection()
    }
    reportPartial(convIds.length, succeeded.length, 'archive')
  }, [selectedIds, selectedConversationIds, inboxView, toast, clearSelection, reportPartial])

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

      <div className="flex-1 space-y-7 min-w-0">
      {/* New messages banner (Feature 3) */}
      {newMessageCount > 0 && (
        <div
          onClick={handleRefreshNewMessages}
          className="fixed top-4 left-1/2 z-50 -translate-x-1/2 cursor-pointer animate-fade-in"
        >
          <div className="flex items-center gap-2 rounded-full border border-[var(--brand-accent)]/20 bg-[var(--brand-accent)]/10 px-5 py-2.5 shadow-lg hover:bg-[var(--brand-accent)]/20 transition-colors">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand-accent)] opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--brand-accent)]" />
            </span>
            <span className="text-sm font-medium text-[var(--brand-accent)]">
              {newMessageCount} new message{newMessageCount > 1 ? 's' : ''} — Click to refresh
            </span>
          </div>
        </div>
      )}

      {/* Scroll anchor */}
      <div ref={listTopRef} />

      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {inboxView === 'spam' ? 'Spam / Junk' : inboxView === 'newsletter' ? 'Newsletters' : 'Unified Inbox'}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
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
            className="md:hidden inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            aria-label="Open filters"
          >
            <Filter size={14} />
            Filters
            {(() => {
              const n = Object.values(facetFilters).filter(Boolean).length
              return n > 0 ? <span className="rounded-full bg-[var(--brand-accent)] text-white px-2 py-0.5 text-xs">{n}</span> : null
            })()}
          </button>
        )}
      </div>

      {/* Dashboard filter banner */}
      {(dashboardFilter || filters.channel !== 'all' || filters.category !== 'all' || filters.sentiment !== 'all') && (searchParams.get('filter') || searchParams.get('channel') || searchParams.get('category') || searchParams.get('sentiment')) && (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--brand-accent)]/20 bg-[var(--brand-accent)]/10 px-4 py-2 text-sm">
          <span className="font-medium text-[var(--brand-accent)]">
            Filtered view from Dashboard:
          </span>
          <span className="text-[var(--brand-accent)]">
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
            className="ml-auto text-[var(--brand-accent)] hover:opacity-80"
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
            inboxView === 'inbox' ? 'bg-[var(--brand-accent)] text-white shadow-sm' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
          }`}
        >
          <Inbox className="h-4 w-4" />
          Inbox
          {inboxCount > 0 && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                inboxView === 'inbox'
                  ? 'bg-white/25 text-white'
                  : 'bg-[var(--brand-accent)]/10 text-[var(--brand-accent)]'
              }`}
            >
              {inboxCount}
            </span>
          )}
        </button>
        <button
          onClick={() => { setInboxView('newsletter'); setSelectedItem(null) }}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            inboxView === 'newsletter' ? 'bg-amber-100 text-amber-800 shadow-sm' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
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
            inboxView === 'spam' ? 'bg-red-100 text-red-800 shadow-sm' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
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
              <span className="inline-flex items-center gap-2 rounded-full border border-[var(--brand-accent)]/20 bg-[var(--brand-accent)]/10 px-3 py-1 text-sm font-medium text-[var(--brand-accent)]">
                <SVIcon className="h-3.5 w-3.5" />
                Viewing: {activeView.name}
                <button
                  onClick={clearActiveView}
                  className="ml-1 rounded-full p-0.5 text-[var(--brand-accent)] hover:bg-[var(--brand-accent)]/20 transition-colors"
                  title="Clear view"
                  aria-label="Clear active saved view"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => { setEditingView(activeView); setShowSaveViewModal(true) }}
                  className="rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--brand-accent)] hover:bg-[var(--brand-accent)]/20 transition-colors"
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
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 text-sm font-medium text-zinc-700 hover:border-[var(--brand-accent)]/40 hover:bg-[var(--brand-accent)]/10 hover:text-[var(--brand-accent)] transition-colors"
              title="Save current filters as a saved view"
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
              Save as view
            </button>
          )}
        </div>
      )}

      {/* Filters bar — narrow facet dropdowns + search. The 3 view-scope
         toggles (My Conversations / Show snoozed / Save view) used to sit
         here detached on the right edge — they've been moved to the
         toolbar row below where they group naturally with the other
         scope/action controls. */}
      {inboxView === 'inbox' && (
        <div>
          <InboxFiltersBar filters={filters} onChange={setFilters} />
        </div>
      )}

      {/* ─────────────────────── Toolbar ───────────────────────────────
         All scope/view/action controls live in ONE bar. Three groups
         separated by vertical dividers so the eye reads them as distinct:
           [Showing X • View mode]   [Scope toggles]   [Bulk actions]
         The 3 scope toggles (My Conversations / Show snoozed / Save view)
         used to sit detached on the filters row — they belong here with
         the other "act on the inbox" controls. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-border bg-card px-4 py-3">
        {/* ─ Group 1: count + view mode ─────────────────────────────── */}
        <div className="flex items-center gap-3">
          <p className="text-sm text-zinc-600">
            Showing{' '}
            <span className="font-semibold text-foreground">{filteredItems.length}</span>{' '}
            of{' '}
            <span className="font-semibold text-foreground">{items.length}</span>{' '}
            {items.length === 1 ? 'conversation' : 'conversations'}
          </p>
          {/* Background refresh — the list stays put; just hint that fresher
              data is on the way instead of flashing skeletons. */}
          {refreshing && (
            <span
              className="inline-flex items-center gap-1 text-xs text-zinc-500"
              title="Refreshing in the background"
            >
              <Loader2 size={12} className="animate-spin" />
              <span className="hidden sm:inline">Refreshing…</span>
            </span>
          )}
          {/* View mode toggle — hidden on mobile (split view not usable) */}
          <div className="hidden sm:flex items-center rounded-lg border border-border bg-zinc-50 p-1">
            <button
              onClick={() => handleViewModeChange('list')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === 'list'
                  ? 'bg-[var(--brand-accent)] text-white shadow-sm'
                  : 'text-muted-foreground hover:text-zinc-700 hover:bg-white'
              }`}
              title="List view"
            >
              <List size={14} />
              List
            </button>
            <button
              onClick={() => handleViewModeChange('split')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === 'split'
                  ? 'bg-[var(--brand-accent)] text-white shadow-sm'
                  : 'text-muted-foreground hover:text-zinc-700 hover:bg-white'
              }`}
              title="Split view"
            >
              <Columns size={14} />
              Split
            </button>
            <button
              onClick={() => handleViewModeChange('kanban')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === 'kanban'
                  ? 'bg-[var(--brand-accent)] text-white shadow-sm'
                  : 'text-muted-foreground hover:text-zinc-700 hover:bg-white'
              }`}
              title="Kanban board"
            >
              <LayoutGrid size={14} />
              Board
            </button>
          </div>
        </div>

        {/* ─ Group 2: scope toggles (moved here from the filters row) ─ */}
        {inboxView === 'inbox' && (
          <>
            <div className="hidden md:block h-6 w-px bg-border" />
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setMyConversationsOnly(!myConversationsOnly)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  myConversationsOnly
                    ? 'bg-[var(--brand-accent)] text-white shadow-sm'
                    : 'bg-white text-zinc-600 border border-border hover:bg-zinc-50'
                }`}
              >
                <User size={14} />
                <span className="hidden sm:inline">My Conversations</span>
                <span className="sm:hidden">Mine</span>
              </button>
              <button
                onClick={() => setShowSnoozed((v) => !v)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  showSnoozed
                    ? 'bg-amber-500 text-white shadow-sm'
                    : 'bg-white text-zinc-600 border border-border hover:bg-zinc-50 hover:border-amber-300 hover:text-amber-700'
                }`}
                title={showSnoozed ? 'Hide snoozed conversations' : 'Show snoozed conversations alongside your inbox'}
              >
                <Clock size={14} />
                <span className="hidden sm:inline">{showSnoozed ? 'Hide snoozed' : 'Show snoozed'}</span>
                <span className="sm:hidden">Snoozed</span>
              </button>
              <button
                onClick={() => { setEditingView(null); setShowSaveViewModal(true) }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-sm font-medium text-zinc-600 hover:border-[var(--brand-accent)]/40 hover:bg-[var(--brand-accent)]/10 hover:text-[var(--brand-accent)] transition-colors whitespace-nowrap"
                title="Save current filters as a view"
              >
                <Bookmark size={14} />
                <span className="hidden sm:inline">Save view</span>
              </button>
            </div>
          </>
        )}

        {/* ─ Group 3: bulk actions (right-aligned with ml-auto) ────── */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
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
            disabled={selectedIds.size === 0 || !canAssign}
            title={!canAssign ? 'You do not have permission to assign conversations' : undefined}
            onClick={() => {
              if (selectedIds.size === 0) { toast.warning('Select messages first'); return }
              // Routes through the guarded POST /api/conversations/[id]/assign
              // (self-assign) — same handler the floating bar's "Assign to me" uses.
              handleAssignMeBulk()
            }}
          >
            <UserPlus className="h-4 w-4" />
            Assign to Me
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={selectedIds.size === 0 || !canSend}
            title={!canSend ? 'You do not have permission to update conversations' : undefined}
            onClick={() => {
              if (selectedIds.size === 0) {
                toast.warning('Select messages first.')
                return
              }
              const messageIds = filteredItems
                .filter((item) => selectedIds.has(item.id))
                .map((item) => item.message_id)
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
            disabled={selectedIds.size === 0 || !canSend}
            title={!canSend ? 'You do not have permission to update conversations' : undefined}
            onClick={() => {
              if (selectedIds.size === 0) {
                toast.warning('Select messages first.')
                return
              }
              const messageIds = filteredItems
                .filter((item) => selectedIds.has(item.id))
                .map((item) => item.message_id)
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
          <div className="mx-4 w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Confirm Action</h3>
            <p className="mt-2 text-sm text-zinc-600">
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
          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 rounded-xl border border-border bg-card px-3 sm:px-5 py-3 shadow-2xl">
            <span className="text-sm font-semibold text-zinc-700">
              {selectedIds.size} selected
            </span>
            <div className="hidden sm:block h-5 w-px bg-border" />
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
              disabled={!canSend}
              title={!canSend ? 'You do not have permission to update conversations' : undefined}
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
              disabled={!canSend}
              title={!canSend ? 'You do not have permission to update conversations' : undefined}
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
              disabled={!canSend}
              title={!canSend ? 'You do not have permission to update conversations' : undefined}
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
              disabled={!canAssign}
              title={!canAssign ? 'You do not have permission to assign conversations' : undefined}
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
              className="ml-1 rounded-full p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-zinc-500 hover:bg-zinc-100 hover:text-zinc-600 transition-colors"
              title="Clear selection"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Loading state — skeleton rows, FIRST load of a query only. Background
          refreshes keep the existing list rendered (see `refreshing`). */}
      {initialLoading && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
          {Array.from({ length: 8 }).map((_, i) => (
            <InboxRowSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Error state */}
      {!initialLoading && error && (
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
      {!initialLoading && !error && items.length === 0 && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
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
              description={`Connect ${CHANNEL_TEASER} to start receiving messages, or click Sync to pull new mail from your existing channels.`}
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button variant="primary" onClick={handleSync} loading={syncing}>
                    <RefreshCw className="h-4 w-4" />
                    Sync now
                  </Button>
                  <Link href="/admin/channels">
                    <Button variant="secondary">
                      Connect a channel
                    </Button>
                  </Link>
                </div>
              }
              hint="Tip: connected channels poll every 2 minutes automatically while this tab is open."
            />
          )}
        </div>
      )}

      {/* Filtered empty state */}
      {!initialLoading && !error && items.length > 0 && filteredItems.length === 0 && inboxView === 'inbox' && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
          <EmptyState
            icon={Inbox}
            title="No messages match your filters"
            description="Try adjusting your filters or check back later."
          />
        </div>
      )}

      {/* Spam / Newsletter list */}
      {!initialLoading && !error && inboxView !== 'inbox' && items.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-600">
              <span className="font-semibold text-foreground">{items.length}</span>{' '}
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
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {items.map((item) => (
              <Link
                key={item.id}
                href={`/conversations/${item.conversation_id}`}
                className="flex items-start gap-4 px-4 py-3 hover:bg-zinc-50 transition-colors group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate group-hover:text-[var(--brand-accent)]">
                      {item.sender_name || 'Unknown'}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {item.channel}
                    </span>
                  </div>
                  <p className="text-sm text-zinc-700 font-medium truncate mt-0.5">
                    {item.subject_or_preview || '(no subject)'}
                  </p>
                  {item.body_preview && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
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
                  <span className="text-xs text-zinc-500 whitespace-nowrap">
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
      {!initialLoading && !error && inboxView === 'inbox' && filteredItems.length > 0 && viewMode === 'list' && (
        <InboxList
          items={filteredItems}
          selectedIds={selectedIds}
          onSelectionChange={handleSelectionChange}
          onItemRemoved={handleItemRemoved}
          onItemUpdated={handleItemUpdated}
        />
      )}

      {/* Split view — on mobile (<md) collapses to single-pane: list shown
          until a row is tapped, then preview swaps in with a Back button */}
      {!initialLoading && !error && inboxView === 'inbox' && filteredItems.length > 0 && viewMode === 'split' && (
        <div className="flex flex-col md:flex-row rounded-lg border border-border bg-card overflow-hidden" style={{ height: 'calc(100vh - 320px)' }}>
          {/* Left: message list — hidden on mobile when an item is selected */}
          <div className={`md:w-[45%] md:shrink-0 overflow-y-auto md:border-r md:border-border ${selectedItem ? 'hidden md:block' : 'block'} flex-1 md:flex-initial`}>
            <InboxList
              items={filteredItems}
              onItemClick={handleItemClick}
              selectedItemId={selectedItem?.id || null}
              selectedIds={selectedIds}
              onSelectionChange={handleSelectionChange}
              onItemRemoved={handleItemRemoved}
              onItemUpdated={handleItemUpdated}
            />
          </div>

          {/* Right: conversation preview — hidden on mobile when no selection */}
          <div className={`flex-1 overflow-hidden bg-zinc-50 ${selectedItem ? 'flex flex-col' : 'hidden md:flex md:flex-col'}`}>
            {selectedItem ? (
              <>
                {/* Mobile back button */}
                <button
                  type="button"
                  onClick={() => setSelectedItem(null)}
                  className="md:hidden flex items-center gap-2 border-b border-border bg-card px-4 py-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 min-h-[44px]"
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
                  <Inbox className="mx-auto h-10 w-10 text-zinc-300" />
                  <p className="mt-3 text-sm font-medium text-muted-foreground">
                    Select a message to preview
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Click any message on the left to see the conversation
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Kanban board view */}
      {!initialLoading && !error && inboxView === 'inbox' && filteredItems.length > 0 && viewMode === 'kanban' && (
        <InboxKanban items={filteredItems} />
      )}

      {/* Load More button — hidden during background refreshes too: the
          refresh's page-1 replace and an append must never interleave. */}
      {!initialLoading && !refreshing && !error && hasMore && (
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
