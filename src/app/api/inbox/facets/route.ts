// GET /api/inbox/facets
//
// Returns aggregate counts for the smart-inbox sidebar — categories, sentiments,
// urgencies, channels, conversation statuses, and assignment buckets — all
// scoped to the caller's company (or all companies for super_admin) and
// filtered to currently-pending inbound messages (the same set that the inbox
// list shows by default).
//
// Counts respect any filters the caller passes via query string: ?category=,
// ?sentiment=, ?urgency=, ?channel=, ?status=, ?assignment= (me|unassigned),
// ?accountId=, so the sidebar can show "what would happen if I added this
// other filter on top of the current ones" — i.e. each facet section's counts
// reflect the OTHER active filters (the section's own filter is excluded so
// switching within a section doesn't zero everything out).

import { NextResponse } from 'next/server'

import { getCurrentUser, isSuperAdmin } from '@/lib/auth'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'

// Channels we surface in the sidebar. Anything outside this list still gets
// counted in `total` but doesn't appear as a chip.
const CHANNELS = ['email', 'teams', 'whatsapp'] as const
const SENTIMENTS = ['positive', 'neutral', 'negative'] as const
const URGENCIES = ['low', 'medium', 'high', 'urgent'] as const
const STATUSES = [
  'active',
  'in_progress',
  'waiting_on_customer',
  'resolved',
  'escalated',
  'archived',
] as const

export type InboxFacets = {
  categories: { name: string; count: number }[]
  sentiments: Record<string, number>
  urgencies: Record<string, number>
  channels: Record<string, number>
  statuses: Record<string, number>
  assigned_to_me: number
  unassigned: number
  total: number
}

interface FacetFilters {
  category?: string
  sentiment?: string
  urgency?: string
  channel?: string
  status?: string
  assignment?: 'me' | 'unassigned'
  accountId?: string
}

function readFilters(url: URL): FacetFilters {
  const get = (k: string) => {
    const v = url.searchParams.get(k)
    return v && v !== 'all' ? v : undefined
  }
  const assignment = get('assignment')
  return {
    category: get('category'),
    sentiment: get('sentiment'),
    urgency: get('urgency'),
    channel: get('channel'),
    status: get('status'),
    assignment:
      assignment === 'me' || assignment === 'unassigned' ? assignment : undefined,
    accountId: get('accountId'),
  }
}

/**
 * Build the filtered set of inbound message IDs that match the given
 * facet filters, scoped to the allowed accounts. Returns the IDs (so we can
 * compute "facet excluding self" buckets without re-running the whole join
 * for every chip).
 *
 * `excludeKey` lets the caller skip one filter — used when computing each
 * facet section's counts so toggling between chips in the same section
 * doesn't collapse to zero.
 */
async function fetchMatchingMessageIds(
  // We only care about the runtime shape here, not the typed Supabase client.
  // Using `unknown` and narrowing avoids pulling in the full Database type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  allowedAccountIds: string[] | null,
  filters: FacetFilters,
  excludeKey: keyof FacetFilters | null,
  currentUserId: string,
): Promise<{
  messages: Array<{
    id: string
    channel: string
    account_id: string
    conversation_id: string
  }>
  classifications: Map<string, { category: string | null; sentiment: string | null; urgency: string | null }>
  conversations: Map<string, { status: string | null; assigned_to: string | null }>
}> {
  // Step 1 — pull inbound, non-spam messages for the allowed accounts.
  let mq = admin
    .from('messages')
    .select('id, channel, account_id, conversation_id')
    .eq('direction', 'inbound')
    .eq('is_spam', false)

  if (allowedAccountIds && allowedAccountIds.length === 0) {
    return { messages: [], classifications: new Map(), conversations: new Map() }
  }
  if (allowedAccountIds && allowedAccountIds.length > 0) {
    mq = mq.in('account_id', allowedAccountIds)
  }

  // Caller-provided account scope (overrides allowed when narrower).
  if (filters.accountId && excludeKey !== 'accountId') {
    mq = mq.eq('account_id', filters.accountId)
  }
  if (filters.channel && excludeKey !== 'channel') {
    mq = mq.eq('channel', filters.channel)
  }

  const { data: msgRows, error: msgErr } = await mq.limit(5000)
  if (msgErr) throw msgErr
  const messages = (msgRows ?? []) as Array<{
    id: string
    channel: string
    account_id: string
    conversation_id: string
  }>
  if (messages.length === 0) {
    return { messages: [], classifications: new Map(), conversations: new Map() }
  }

  // Step 2 — pull classifications for those messages (one row per message).
  const messageIds = messages.map((m) => m.id)
  const { data: classRows, error: classErr } = await admin
    .from('message_classifications')
    .select('message_id, category, sentiment, urgency')
    .in('message_id', messageIds)
  if (classErr) throw classErr
  const classifications = new Map<
    string,
    { category: string | null; sentiment: string | null; urgency: string | null }
  >()
  for (const row of (classRows ?? []) as Array<{
    message_id: string
    category: string | null
    sentiment: string | null
    urgency: string | null
  }>) {
    classifications.set(row.message_id, {
      category: row.category,
      sentiment: row.sentiment,
      urgency: row.urgency,
    })
  }

  // Step 3 — pull conversation status / assignment for the affected convs.
  const convIds = Array.from(new Set(messages.map((m) => m.conversation_id))).filter(Boolean)
  const conversations = new Map<string, { status: string | null; assigned_to: string | null }>()
  if (convIds.length > 0) {
    const { data: convRows, error: convErr } = await admin
      .from('conversations')
      .select('id, status, assigned_to')
      .in('id', convIds)
    if (convErr) throw convErr
    for (const row of (convRows ?? []) as Array<{
      id: string
      status: string | null
      assigned_to: string | null
    }>) {
      conversations.set(row.id, { status: row.status, assigned_to: row.assigned_to })
    }
  }

  // Now apply the remaining filters in TS — each facet's count call passes
  // its own key in `excludeKey` so its chips stay non-zero.
  const filtered = messages.filter((m) => {
    const classification = classifications.get(m.id)
    const conv = conversations.get(m.conversation_id)
    if (filters.category && excludeKey !== 'category') {
      if ((classification?.category ?? null) !== filters.category) return false
    }
    if (filters.sentiment && excludeKey !== 'sentiment') {
      if ((classification?.sentiment ?? null) !== filters.sentiment) return false
    }
    if (filters.urgency && excludeKey !== 'urgency') {
      if ((classification?.urgency ?? null) !== filters.urgency) return false
    }
    if (filters.status && excludeKey !== 'status') {
      if ((conv?.status ?? null) !== filters.status) return false
    }
    if (filters.assignment && excludeKey !== 'assignment') {
      if (filters.assignment === 'me') {
        if ((conv?.assigned_to ?? null) !== currentUserId) return false
      } else {
        // 'unassigned'
        if (conv?.assigned_to) return false
      }
    }
    return true
  })

  return {
    messages: filtered,
    classifications,
    conversations,
  }
}

/**
 * Resolve the set of account_ids the caller is allowed to see.
 *   - super_admin → null (no scope)
 *   - company user → all accounts in their company
 *   - untethered user → empty list (deny)
 */
async function resolveAllowedAccounts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  user: { role: string; company_id: string | null; account_id: string | null },
): Promise<string[] | null> {
  if (isSuperAdmin(user.role)) return null
  if (user.company_id) {
    const { data } = await admin
      .from('accounts')
      .select('id')
      .eq('company_id', user.company_id)
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (user.account_id && !ids.includes(user.account_id)) ids.push(user.account_id)
    return ids
  }
  if (user.account_id) return [user.account_id]
  return []
}

export async function GET(request: Request) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const profile = await getCurrentUser(authUser.id)
  if (!profile) {
    return NextResponse.json({ error: 'No profile found for user' }, { status: 403 })
  }

  const admin = await createServiceRoleClient()
  const allowedAccountIds = await resolveAllowedAccounts(admin, profile)

  const url = new URL(request.url)
  const filters = readFilters(url)

  // Fetch ONE base set with no filters — we then apply different exclude
  // keys per facet section in TS using the cached classifications/conversations.
  const base = await fetchMatchingMessageIds(
    admin,
    allowedAccountIds,
    {},
    null,
    authUser.id,
  )

  // Helper that re-applies all filters except `excludeKey`, walking the
  // already-fetched base set.
  const subset = (excludeKey: keyof FacetFilters | null) => {
    return base.messages.filter((m) => {
      const c = base.classifications.get(m.id)
      const conv = base.conversations.get(m.conversation_id)
      if (filters.accountId && excludeKey !== 'accountId') {
        if (m.account_id !== filters.accountId) return false
      }
      if (filters.channel && excludeKey !== 'channel') {
        if (m.channel !== filters.channel) return false
      }
      if (filters.category && excludeKey !== 'category') {
        if ((c?.category ?? null) !== filters.category) return false
      }
      if (filters.sentiment && excludeKey !== 'sentiment') {
        if ((c?.sentiment ?? null) !== filters.sentiment) return false
      }
      if (filters.urgency && excludeKey !== 'urgency') {
        if ((c?.urgency ?? null) !== filters.urgency) return false
      }
      if (filters.status && excludeKey !== 'status') {
        if ((conv?.status ?? null) !== filters.status) return false
      }
      if (filters.assignment && excludeKey !== 'assignment') {
        if (filters.assignment === 'me') {
          if ((conv?.assigned_to ?? null) !== authUser.id) return false
        } else {
          if (conv?.assigned_to) return false
        }
      }
      return true
    })
  }

  // total = subset with NO key excluded (i.e. all current filters applied).
  const totalSet = subset(null)
  const total = totalSet.length

  // Categories
  const categoryCounts = new Map<string, number>()
  for (const m of subset('category')) {
    const cat = base.classifications.get(m.id)?.category ?? 'Uncategorized'
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1)
  }
  const categories = Array.from(categoryCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  // Sentiments
  const sentiments: Record<string, number> = {}
  for (const s of SENTIMENTS) sentiments[s] = 0
  for (const m of subset('sentiment')) {
    const s = base.classifications.get(m.id)?.sentiment
    if (s && s in sentiments) sentiments[s]++
  }

  // Urgencies
  const urgencies: Record<string, number> = {}
  for (const u of URGENCIES) urgencies[u] = 0
  for (const m of subset('urgency')) {
    const u = base.classifications.get(m.id)?.urgency
    if (u && u in urgencies) urgencies[u]++
  }

  // Channels
  const channels: Record<string, number> = {}
  for (const c of CHANNELS) channels[c] = 0
  for (const m of subset('channel')) {
    if (m.channel in channels) channels[m.channel]++
  }

  // Statuses
  const statuses: Record<string, number> = {}
  for (const s of STATUSES) statuses[s] = 0
  for (const m of subset('status')) {
    const st = base.conversations.get(m.conversation_id)?.status
    if (st && st in statuses) statuses[st]++
  }

  // Assigned to me / unassigned (assignment facet)
  let assigned_to_me = 0
  let unassigned = 0
  for (const m of subset('assignment')) {
    const assignedTo = base.conversations.get(m.conversation_id)?.assigned_to ?? null
    if (assignedTo === authUser.id) assigned_to_me++
    if (!assignedTo) unassigned++
  }

  const facets: InboxFacets = {
    categories,
    sentiments,
    urgencies,
    channels,
    statuses,
    assigned_to_me,
    unassigned,
    total,
  }

  return NextResponse.json(facets)
}
