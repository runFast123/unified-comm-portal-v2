'use client'

import { useRouter } from 'next/navigation'
import { Archive, AlertTriangle, CheckCheck, Sparkles, Clock } from 'lucide-react'
import { useToast } from '@/components/ui/toast'
import { isUnread } from '@/hooks/useReadStatus'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { Badge } from '@/components/ui/badge'
import { SLABadge } from '@/components/inbox/sla-badge'
import { truncate, timeAgo, getPriorityColor, cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase-client'
import type { InboxItem, ConversationStatus } from '@/types/database'

interface InboxRowProps {
  item: InboxItem
  selected: boolean
  onSelect: (id: string, checked: boolean) => void
  onItemClick?: (item: InboxItem) => void
  isActive?: boolean
}

const avatarColors = [
  'bg-teal-500',
  'bg-blue-500',
  'bg-purple-500',
  'bg-orange-500',
  'bg-pink-500',
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-cyan-500',
  'bg-amber-500',
  'bg-rose-500',
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

export function InboxRow({ item, selected, onSelect, onItemClick, isActive }: InboxRowProps) {
  const router = useRouter()
  const { toast } = useToast()

  const handleRowClick = () => {
    if (onItemClick) {
      onItemClick(item)
    } else if (item.conversation_id) {
      router.push(`/conversations/${item.conversation_id}`)
    }
  }

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation()
  }

  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation()
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
    }
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
  const unread = isUnread(item.conversation_id, item.timestamp)

  // ── Snooze indicator ────────────────────────────────────────────────
  // `snoozed_until` is surfaced from conversations on the InboxItem. We only
  // render the badge when the snooze is still in the future — after that the
  // wake-snoozed cron will null the column out, but we guard here too so we
  // don't briefly show a stale "Snoozed until …" between cron ticks.
  const snoozedUntilIso = item.snoozed_until ?? null
  const snoozedActive = !!snoozedUntilIso && new Date(snoozedUntilIso).getTime() > Date.now()
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
        isActive && 'bg-blue-50 hover:bg-blue-50 ring-1 ring-blue-300'
      )}
    >
      {/* Checkbox */}
      <div onClick={handleCheckboxClick} className="flex-shrink-0">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onSelect(item.id, e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
        />
      </div>

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
            'flex-shrink-0 h-9 w-9 rounded-full flex items-center justify-center text-[11px] font-bold text-white',
            getAvatarColor(accountName || senderName)
          )}
          title={rawSender}
        >
          {getInitials(senderName)}
        </div>
        <div className="min-w-0">
          <p className={cn("text-sm truncate leading-snug", unread ? "font-bold text-gray-900" : "font-medium text-gray-700")}>
            {unread && <span className="inline-block h-1.5 w-1.5 rounded-full bg-teal-500 mr-1" />}
            {senderName}
          </p>
          <div className="flex items-center gap-1.5 mt-1">
            <p className="text-[11px] text-gray-400 truncate leading-tight">
              {accountName.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '')}
            </p>
            {item.channel === 'teams' && (
              <span className="inline-flex shrink-0 rounded bg-indigo-50 px-1 py-0 text-[9px] font-semibold text-indigo-600 border border-indigo-100">
                Teams
              </span>
            )}
            {item.channel === 'whatsapp' && (
              <span className="inline-flex shrink-0 rounded bg-green-50 px-1 py-0 text-[9px] font-semibold text-green-600 border border-green-100">
                WA
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Subject / Preview */}
      <div className="flex-1 min-w-0 pr-2">
        <p className="text-sm text-gray-600 truncate">
          {truncate(item.subject_or_preview, 70)}
        </p>
      </div>

      {/* Right section — compact info */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Snoozed badge — only when the snooze is still active */}
        {snoozedActive && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700"
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
              <span key={tag} className="rounded-full bg-indigo-50 text-indigo-600 px-1.5 py-0 text-[10px] font-medium border border-indigo-100">
                {tag}
              </span>
            ))}
          </div>
        )}

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

      {/* Hover actions — positioned to the LEFT of row content to avoid overlap */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-0.5 bg-white rounded-lg px-1.5 py-1 shadow-lg border border-gray-200 z-10">
        {(item.ai_status === 'no_draft' || item.ai_status === 'classify_only') && (
          <button
            onClick={handleGenerateReply}
            className="p-1.5 rounded-md text-teal-600 hover:bg-teal-50 transition-colors"
            title="Generate AI reply"
          >
            <Sparkles className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={handleMarkReplied}
          className="p-1.5 rounded-md text-gray-400 hover:text-green-600 hover:bg-green-50 transition-colors"
          title="Mark as Replied"
        >
          <CheckCheck className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={handleArchive}
          className="p-1.5 rounded-md text-gray-400 hover:text-teal-600 hover:bg-teal-50 transition-colors"
          title="Archive"
        >
          <Archive className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={handleEscalate}
          className="p-1.5 rounded-md text-gray-400 hover:text-orange-600 hover:bg-orange-50 transition-colors"
          title="Escalate"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
