'use client'

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Archive, AlertTriangle, CheckCheck, Sparkles, Clock, User } from 'lucide-react'
import { useToast } from '@/components/ui/toast'
import { isUnread } from '@/hooks/useReadStatus'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { Badge } from '@/components/ui/badge'
import { SLABadge } from '@/components/inbox/sla-badge'
import { truncate, timeAgo, getPriorityColor, cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase-client'
import { useUser } from '@/context/user-context'
import type { InboxItem, ConversationStatus } from '@/types/database'

// Roles that may NOT take any write action from the inbox row. Mirrors
// the read-only carve-out in conversation-actions.tsx — keep both in
// sync so the inbox hover-actions never tease an action whose API call
// would 403.
const READ_ONLY_ROLES = new Set(['viewer'])

// Imperative surface the parent (InboxList) drives for keyboard triage, so the
// keyboard `e` archive reuses this row's exact Supabase write + toast +
// onItemRemoved call instead of duplicating the archive logic.
export interface InboxRowHandle {
  archive: () => Promise<void>
}

interface InboxRowProps {
  // `assigned_to_name` is joined by the inbox page query (conversations →
  // users); optional so other InboxItem producers don't have to supply it.
  item: InboxItem & { assigned_to_name?: string | null }
  selected: boolean
  onSelect: (id: string, checked: boolean) => void
  onItemClick?: (item: InboxItem) => void
  isActive?: boolean
  // Keyboard-triage focus highlight — distinct from `selected`/`isActive` so
  // the focused row is visible even when also selected or open in split view.
  isFocused?: boolean
  // Optimistic list callbacks: fired AFTER a successful Supabase write so the
  // row leaves / updates immediately rather than lingering until a refetch.
  // Keyed by `message_id` (the inbox row's mutation key), NOT `id`.
  onItemRemoved?: (messageId: string) => void
  onItemUpdated?: (messageId: string, patch: Partial<InboxItem>) => void
  // Called just before navigating to the full conversation view, so the parent
  // can persist the inbox's displayed order for queue navigation (‹ Prev/Next ›
  // + auto-advance in the detail view). Only fires on the navigation path.
  onNavigate?: () => void
}

// Restrained tinted avatar palette (light bg + dark text of the same hue),
// hash-assigned. Calmer than the old saturated -500 rainbow and drops the
// purple/pink hues (off-tone for a calm business tool). getAvatarColor's hashing
// is unchanged — only the palette + the text color (now baked into each pair).
const avatarColors = [
  'bg-teal-100 text-teal-700',
  'bg-blue-100 text-blue-700',
  'bg-amber-100 text-amber-800',
  'bg-emerald-100 text-emerald-700',
  'bg-slate-100 text-slate-700',
  'bg-cyan-100 text-cyan-700',
]

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
    hash |= 0
  }
  return Math.abs(hash)
}

function getAvatarColor(name: string): string {
  return avatarColors[hashString(name) % avatarColors.length]
}

function getInitials(name: string): string {
  const clean = cleanSenderName(name)
  const parts = clean.trim().split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return clean.slice(0, 2).toUpperCase()
}

function cleanSenderName(raw: string): string {
  // Remove email in angle brackets: "Monica" <monica@meratalk.org> → Monica
  let name = raw.replace(/<[^>]+>/g, '').trim()
  // Remove surrounding quotes
  name = name.replace(/^["']+|["']+$/g, '').trim()
  // If empty after cleaning, extract name from email
  if (!name && raw.includes('@')) {
    const email = raw.match(/<([^>]+)>/)?.[1] || raw
    name = email.split('@')[0].replace(/[._-]/g, ' ')
    name = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  }
  return name || 'Unknown'
}

function extractEmail(raw: string): string {
  const match = raw.match(/<([^>]+)>/)
  if (match) return match[1]
  if (raw.includes('@')) return raw.trim()
  return ''
}

function getPriorityBorderClass(priority: string): string {
  switch (priority) {
    case 'urgent':
      return 'border-l-4 border-l-red-500'
    case 'high':
      return 'border-l-4 border-l-orange-500'
    case 'medium':
      return 'border-l-4 border-l-amber-400'
    case 'low':
    default:
      return 'border-l-4 border-l-gray-300'
  }
}

// Human-readable label for the urgency-coded left border bar so screen readers
// and hover tooltips can explain what the colored stripe means.
function getPriorityBarLabel(priority: string): string {
  switch (priority) {
    case 'urgent':
      return 'Urgent priority'
    case 'high':
      return 'High priority'
    case 'medium':
      return 'Medium priority'
    case 'low':
    default:
      return 'Low priority'
  }
}

// Channel chip background — colored circle behind the channel icon so the
// channel type is conveyed at a glance even before reading the label.
function getChannelChipClass(channel: string): string {
  switch (channel) {
    case 'email':
      return 'bg-blue-100 text-blue-600 ring-1 ring-blue-200'
    case 'teams':
      return 'bg-purple-100 text-purple-600 ring-1 ring-purple-200'
    case 'whatsapp':
      return 'bg-green-100 text-green-600 ring-1 ring-green-200'
    default:
      return 'bg-gray-100 text-gray-500 ring-1 ring-gray-200'
  }
}

function getChannelChipTitle(channel: string): string {
  switch (channel) {
    case 'email':
      return 'Email'
    case 'teams':
      return 'Microsoft Teams'
    case 'whatsapp':
      return 'WhatsApp'
    default:
      return channel
  }
}

function getAiStatusBadge(status: InboxItem['ai_status']) {
  switch (status) {
    case 'draft_ready':
      return <Badge variant="success" size="sm">Draft Ready</Badge>
    case 'no_draft':
      return <Badge variant="default" size="sm">No Draft</Badge>
    case 'auto_sent':
      return <Badge variant="info" size="sm">Auto-sent</Badge>
    case 'classify_only':
      return <Badge variant="warning" size="sm">Classify Only</Badge>
  }
}

function getConversationStatusDot(status: ConversationStatus | null) {
  if (!status) return null
  const config: Record<string, { label: string; dotColor: string; ringColor: string }> = {
    active: { label: 'Active', dotColor: 'bg-green-500', ringColor: 'ring-green-200' },
    in_progress: { label: 'In Progress', dotColor: 'bg-blue-500', ringColor: 'ring-blue-200' },
    waiting_on_customer: { label: 'Waiting on customer', dotColor: 'bg-amber-400', ringColor: 'ring-amber-200' },
    resolved: { label: 'Resolved', dotColor: 'bg-gray-400', ringColor: 'ring-gray-200' },
    escalated: { label: 'Escalated', dotColor: 'bg-red-500', ringColor: 'ring-red-200' },
    archived: { label: 'Archived', dotColor: 'bg-gray-300', ringColor: 'ring-gray-200' },
  }
  const c = config[status]
  if (!c) return null
  // Compact colored dot (with a soft ring for visibility on hover) that
  // never clips at narrow widths. Title attribute supplies the full
  // status label on hover; aria-label keeps it screen-reader accessible.
  return (
    <span
      role="img"
      title={`Status: ${c.label}`}
      aria-label={`Status: ${c.label}`}
      className={cn(
        'inline-block h-2.5 w-2.5 rounded-full whitespace-nowrap ring-2 ring-offset-1 ring-offset-white',
        c.dotColor,
        c.ringColor
      )}
    />
  )
}

function getSentimentDot(sentiment: InboxItem['sentiment']) {
  if (!sentiment) return null
  const colors = {
    positive: 'bg-green-500',
    neutral: 'bg-gray-400',
    negative: 'bg-red-500',
  }
  return (
    <span
      className={cn('inline-block h-2.5 w-2.5 rounded-full flex-shrink-0', colors[sentiment])}
      title={sentiment}
    />
  )
}

export const InboxRow = forwardRef<InboxRowHandle, InboxRowProps>(function InboxRow(
  { item, selected, onSelect, onItemClick, isActive, isFocused, onItemRemoved, onItemUpdated, onNavigate }: InboxRowProps,
  ref
) {
  const router = useRouter()
  const { toast } = useToast()
  const { role: viewerRole } = useUser()
  const isReadOnly = READ_ONLY_ROLES.has(viewerRole)

  const handleRowClick = () => {
    if (onItemClick) {
      onItemClick(item)
    } else if (item.conversation_id) {
      // Persist the inbox's displayed order before leaving, so the detail view
      // can offer queue navigation (‹ Prev/Next › + auto-advance).
      onNavigate?.()
      router.push(`/conversations/${item.conversation_id}`)
    }
  }

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation()
  }

  // Shared archive action — the single source of truth for archiving this row.
  // Both the hover "Archive" button and the keyboard `e` shortcut (via the
  // imperative handle below) call this, so the Supabase write, toast and the
  // optimistic `onItemRemoved` removal are never duplicated.
  const archive = async () => {
    // Read-only roles never mutate from the row (their hover actions are
    // hidden); guard the keyboard path the same way.
    if (isReadOnly) return
    const supabase = createClient()
    // When archiving a spam message, also clear is_spam so it doesn't reappear in spam view
    const updateFields = item.is_spam
      ? { replied: true, reply_required: false, is_spam: false }
      : { replied: true, reply_required: false }
    const { error } = await supabase
      .from('messages')
      .update(updateFields)
      .eq('id', item.message_id)
    if (error) {
      console.error('Failed to archive message:', error)
      toast.error('Failed to archive message')
    } else {
      toast.success('Message archived')
      onItemRemoved?.(item.message_id)
    }
  }

  // Expose the archive action to InboxList's keyboard handler.
  useImperativeHandle(ref, () => ({ archive }))

  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await archive()
  }

  const handleEscalate = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const supabase = createClient()
    const { error } = await supabase
      .from('message_classifications')
      .update({ urgency: 'urgent' })
      .eq('message_id', item.message_id)
    if (error) {
      console.error('Failed to escalate message:', error)
      toast.error('Failed to escalate message')
    } else {
      toast.success('Message escalated to urgent')
      // Reflect the new urgency/priority on the row immediately.
      onItemUpdated?.(item.message_id, { urgency: 'urgent', priority: 'urgent' })
    }
  }

  const handleMarkReplied = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const supabase = createClient()
    const { error } = await supabase
      .from('messages')
      .update({ replied: true, reply_required: false })
      .eq('id', item.message_id)
    if (error) {
      console.error('Failed to mark as replied:', error)
      toast.error('Failed to mark as replied')
    } else {
      toast.success('Marked as replied')
      // Marking replied removes the row from the pending inbox, same as archive.
      onItemRemoved?.(item.message_id)
    }
  }

  const handleGenerateReply = async (e: React.MouseEvent) => {
    e.stopPropagation()
    toast.info('Generating AI reply...')
    try {
      const res = await fetch('/api/ai-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_id: item.message_id,
          message_text: item.subject_or_preview,
          channel: item.channel,
          account_id: item.account_id,
          conversation_id: item.conversation_id,
          force: true,
        }),
      })
      if (res.ok) {
        toast.success('AI reply generated — refresh to see it')
      } else {
        const data = await res.json().catch(() => ({}))
        toast.error(data.error || 'Failed to generate reply')
      }
    } catch {
      toast.error('Failed to generate AI reply')
    }
  }

  const priorityColorClass = getPriorityColor(item.priority)
  const rawSender = item.sender_name || 'Unknown'
  const senderName = cleanSenderName(rawSender)
  const senderEmail = extractEmail(rawSender)
  const accountName = item.account_name || ''
  const assigneeName = item.assigned_to_name || null

  // Defer client-only state derivations until after mount so the SSR
  // markup matches the initial client render and React doesn't throw
  // #418 hydration mismatches on every inbox row. Both `isUnread`
  // (reads localStorage — empty on the server) and `Date.now()` (server
  // request time vs client hydration time) produce different values
  // at SSR vs CSR if computed during render.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const unread = mounted && isUnread(item.conversation_id, item.timestamp)

  // ── Snooze indicator ────────────────────────────────────────────────
  // `snoozed_until` is surfaced from conversations on the InboxItem. We only
  // render the badge when the snooze is still in the future — after that the
  // wake-snoozed cron will null the column out, but we guard here too so we
  // don't briefly show a stale "Snoozed until …" between cron ticks.
  const snoozedUntilIso = item.snoozed_until ?? null
  const snoozedActive = mounted && !!snoozedUntilIso && new Date(snoozedUntilIso).getTime() > Date.now()
  const snoozedLabel = snoozedActive
    ? new Date(snoozedUntilIso!).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : ''

  const priorityBarLabel = getPriorityBarLabel(item.priority)
  const channelChipClass = getChannelChipClass(item.channel)
  const channelChipTitle = getChannelChipTitle(item.channel)

  return (
    <div
      onClick={handleRowClick}
      // The colored left bar communicates priority/urgency. We surface it via
      // `aria-label` + `title` so the meaning is discoverable rather than
      // purely decorative.
      aria-label={priorityBarLabel}
      title={`${priorityBarLabel} — colored left bar reflects message priority`}
      className={cn(
        'group relative flex items-center gap-4 px-5 py-4 border-b border-gray-100 min-h-[64px]',
        'hover:bg-gray-50/80 transition-colors cursor-pointer',
        getPriorityBorderClass(item.priority),
        selected && 'bg-teal-50 hover:bg-teal-50',
        isActive && 'bg-blue-50 hover:bg-blue-50 ring-1 ring-blue-300',
        // Keyboard focus highlight — an inset teal ring + subtle tint, distinct
        // from `selected` (teal fill) and `isActive` (blue + outset blue ring).
        isFocused && 'bg-teal-50/40 ring-2 ring-inset ring-teal-400'
      )}
    >
      {/* Checkbox — hidden for read-only roles since bulk actions also 403. */}
      {!isReadOnly && (
        <div onClick={handleCheckboxClick} className="flex-shrink-0">
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(item.id, e.target.checked)}
            className="h-4 w-4 rounded border-border text-[var(--brand-accent)] focus:ring-[var(--brand-accent)] cursor-pointer"
          />
        </div>
      )}

      {/* Channel chip — colored circle around the channel icon makes the
          channel type instantly readable (blue=email, purple=teams,
          green=whatsapp) rather than relying on a tiny monochrome icon. */}
      <div
        className={cn(
          'flex-shrink-0 flex items-center justify-center h-7 w-7 rounded-full',
          channelChipClass
        )}
        title={channelChipTitle}
        aria-label={`Channel: ${channelChipTitle}`}
      >
        <ChannelIcon channel={item.channel} size={14} className="text-current" />
      </div>

      {/* Sender avatar + Name + Company + Channel badge.
          User measured offsetWidth=240px vs scrollWidth=242px on the
          previous w-72 (288px container = 240px text after avatar+gap).
          Bumped one more notch — xl:w-80 (320px container = 272px text
          area) — so "Dexter via Zammad Helpdesk Support" and
          "Twiching General Trading Pte Ltd" fit cleanly without those
          off-by-2-pixel truncations. */}
      <div className="w-48 md:w-56 xl:w-80 flex-shrink-0 min-w-0 flex items-center gap-3">
        <div
          className={cn(
            'flex-shrink-0 h-9 w-9 rounded-full flex items-center justify-center text-[11px] font-bold',
            getAvatarColor(accountName || senderName)
          )}
          title={rawSender}
        >
          {getInitials(senderName)}
        </div>
        <div className="min-w-0">
          <p className={cn("text-sm truncate leading-snug", unread ? "font-bold text-foreground" : "font-medium text-zinc-700")}>
            {unread && <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand-accent)] mr-1" />}
            {senderName}
          </p>
          <div className="flex items-center gap-1.5 mt-1">
            <p className="text-[11px] text-zinc-500 truncate leading-tight">
              {accountName.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '')}
            </p>
            {item.channel === 'teams' && (
              <span className="inline-flex shrink-0 rounded bg-indigo-50 px-1 py-0 text-[10px] font-semibold text-indigo-600 border border-indigo-100">
                Teams
              </span>
            )}
            {item.channel === 'whatsapp' && (
              <span className="inline-flex shrink-0 rounded bg-green-50 px-1 py-0 text-[10px] font-semibold text-green-600 border border-green-100">
                WA
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Subject / Preview */}
      <div className="flex-1 min-w-0 pr-2">
        <p className="text-sm text-zinc-600 truncate">
          {truncate(item.subject_or_preview, 70)}
        </p>
      </div>

      {/* Right section — compact info */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Snoozed badge — only when the snooze is still active */}
        {snoozedActive && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
            title={`Snoozed until ${snoozedLabel} — auto-resurfaces when due`}
          >
            <Clock className="h-2.5 w-2.5" />
            <span className="hidden md:inline">Snoozed until {snoozedLabel}</span>
            <span className="md:hidden">Snoozed</span>
          </span>
        )}
        {/* Category */}
        <div className="hidden lg:block">
          {item.category && (
            <Badge variant="default" size="sm">{item.category}</Badge>
          )}
        </div>

        {/* Conversation tags */}
        {item.tags && item.tags.length > 0 && (
          <div className="hidden xl:flex items-center gap-1">
            {item.tags.slice(0, 2).map(tag => (
              <span key={tag} className="rounded-full bg-indigo-50 text-indigo-600 px-1.5 py-0 text-[11px] font-medium border border-indigo-100">
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Assignee — initials avatar with the assignee's name on hover;
            empty when unassigned. Fixed-width wrapper keeps the badge
            columns aligned (same idiom as the status/sentiment dots). */}
        <div className="hidden md:flex w-5 justify-center">
          {item.assigned_to && (
            <span
              role="img"
              title={`Assigned to ${assigneeName ?? 'a teammate'}`}
              aria-label={`Assigned to ${assigneeName ?? 'a teammate'}`}
              className={cn(
                'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                assigneeName ? getAvatarColor(assigneeName) : 'bg-zinc-200 text-zinc-500'
              )}
            >
              {assigneeName ? getInitials(assigneeName) : <User className="h-3 w-3" />}
            </span>
          )}
        </div>

        {/* Status dot — compact colored dot, never clips. Hover/aria
            reveal the full status label. */}
        <div className="hidden md:flex w-4 justify-center">
          {getConversationStatusDot(item.conversation_status)}
        </div>

        {/* Sentiment dot */}
        <div className="hidden md:flex w-5 justify-center">
          {getSentimentDot(item.sentiment)}
        </div>

        {/* SLA */}
        <div className="w-20 text-right hidden sm:block">
          <SLABadge
            receivedAt={item.time_waiting}
            conversationStatus={item.conversation_status}
          />
        </div>

        {/* Priority */}
        <Badge className={cn(priorityColorClass, 'text-[10px] whitespace-nowrap')} size="sm">
          {item.priority.charAt(0).toUpperCase() + item.priority.slice(1)}
        </Badge>

        {/* AI Status */}
        {getAiStatusBadge(item.ai_status)}
      </div>

      {/* Hover actions — positioned to the LEFT of row content to avoid
          overlap. Hidden entirely for read-only roles so we don't tease
          buttons whose underlying API mutations would 403. */}
      {!isReadOnly && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex group-focus-within:flex items-center gap-0.5 bg-card rounded-lg px-1.5 py-1 shadow-lg border border-border z-10">
          {(item.ai_status === 'no_draft' || item.ai_status === 'classify_only') && (
            <button
              onClick={handleGenerateReply}
              className="p-2 rounded-md text-[var(--brand-accent)] hover:bg-[var(--brand-accent)]/10 transition-colors"
              title="Generate AI reply"
              aria-label="Generate AI reply"
            >
              <Sparkles className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={handleMarkReplied}
            className="p-2 rounded-md text-zinc-500 hover:text-green-600 hover:bg-green-50 transition-colors"
            title="Mark as Replied"
            aria-label="Mark as Replied"
          >
            <CheckCheck className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleArchive}
            className="p-2 rounded-md text-zinc-500 hover:text-[var(--brand-accent)] hover:bg-[var(--brand-accent)]/10 transition-colors"
            title="Archive"
            aria-label="Archive"
          >
            <Archive className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleEscalate}
            className="p-2 rounded-md text-zinc-500 hover:text-orange-600 hover:bg-orange-50 transition-colors"
            title="Escalate"
            aria-label="Escalate"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
})
