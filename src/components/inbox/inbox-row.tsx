'use client'

import { useRouter } from 'next/navigation'
import { Archive, AlertTriangle, CheckCheck, Sparkles } from 'lucide-react'
import { useToast } from '@/components/ui/toast'
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
      return 'border-l-4 border-l-blue-400'
    case 'low':
    default:
      return 'border-l-4 border-l-gray-300'
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

function getConversationStatusBadge(status: ConversationStatus | null) {
  if (!status) return null
  const config: Record<string, { label: string; dotColor: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'default' }> = {
    active: { label: 'Active', dotColor: 'bg-green-500', variant: 'success' },
    in_progress: { label: 'In Progress', dotColor: 'bg-blue-500', variant: 'info' },
    waiting_on_customer: { label: 'Waiting', dotColor: 'bg-amber-400', variant: 'warning' },
    resolved: { label: 'Resolved', dotColor: 'bg-gray-400', variant: 'default' },
    escalated: { label: 'Escalated', dotColor: 'bg-red-500', variant: 'danger' },
    archived: { label: 'Archived', dotColor: 'bg-gray-300', variant: 'default' },
  }
  const c = config[status]
  if (!c) return null
  return (
    <Badge variant={c.variant} size="sm">
      <span className={cn('inline-block h-1.5 w-1.5 rounded-full mr-1', c.dotColor)} />
      {c.label}
    </Badge>
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

  return (
    <div
      onClick={handleRowClick}
      className={cn(
        'group relative flex items-center gap-3 px-4 py-3.5 border-b border-gray-100',
        'hover:shadow-md hover:bg-gray-50/80 transition-all duration-200 cursor-pointer',
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

      {/* Channel icon */}
      <div className="flex-shrink-0">
        <ChannelIcon channel={item.channel} size={18} />
      </div>

      {/* Sender avatar + Name & Company + Subject stacked on mobile */}
      <div className="sm:w-48 flex-shrink-0 min-w-0 flex items-center gap-2.5 max-sm:flex-1">
        <div
          className={cn(
            'flex-shrink-0 h-9 w-9 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-sm',
            getAvatarColor(accountName || senderName)
          )}
          title={rawSender}
        >
          {getInitials(senderName)}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate leading-tight">
            {senderName}
          </p>
          <p className="text-xs text-gray-400 truncate leading-tight mt-0.5">{accountName}</p>
          {/* Subject visible on mobile below sender name */}
          <p className="text-xs text-gray-500 truncate leading-tight mt-0.5 sm:hidden">
            {truncate(item.subject_or_preview, 50)}
          </p>
        </div>
      </div>

      {/* Subject / Preview - hidden on mobile (shown inline above) */}
      <div className="flex-1 min-w-0 pr-2 hidden sm:block">
        <p className="text-sm text-gray-700 truncate leading-snug">
          {truncate(item.subject_or_preview, 80)}
        </p>
      </div>

      {/* Category - hidden on small screens */}
      <div className="flex-shrink-0 hidden md:block">
        {item.category && (
          <Badge variant="default" size="sm">
            {item.category}
          </Badge>
        )}
      </div>

      {/* Conversation Status - hidden on small screens */}
      <div className="flex-shrink-0 hidden lg:block">
        {getConversationStatusBadge(item.conversation_status)}
      </div>

      {/* Sentiment - hidden on small screens */}
      <div className="flex-shrink-0 w-6 justify-center hidden md:flex">
        {getSentimentDot(item.sentiment)}
      </div>

      {/* SLA wait time */}
      <div className="flex-shrink-0 w-24 text-right">
        <SLABadge
          receivedAt={item.time_waiting}
          conversationStatus={item.conversation_status}
        />
      </div>

      {/* Priority */}
      <div className="flex-shrink-0">
        <Badge className={priorityColorClass} size="sm">
          {item.priority.charAt(0).toUpperCase() + item.priority.slice(1)}
        </Badge>
      </div>

      {/* AI Status */}
      <div className="flex-shrink-0 flex items-center gap-1.5">
        {getAiStatusBadge(item.ai_status)}
        {(item.ai_status === 'no_draft' || item.ai_status === 'classify_only') && (
          <button
            onClick={handleGenerateReply}
            className="inline-flex items-center gap-1 rounded-md bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700 hover:bg-teal-100 transition-colors"
            title="Generate AI reply for this message"
          >
            <Sparkles className="h-3 w-3" />
            Generate
          </button>
        )}
      </div>

      {/* Quick action buttons on hover */}
      <div className="absolute right-3 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-1 bg-white/90 backdrop-blur-sm rounded-lg px-1 py-0.5 shadow-md border border-gray-200">
        <button
          onClick={handleMarkReplied}
          className="p-1.5 rounded-md text-gray-400 hover:text-green-600 hover:bg-green-50 transition-colors"
          title="Mark as Replied (replied outside portal)"
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
