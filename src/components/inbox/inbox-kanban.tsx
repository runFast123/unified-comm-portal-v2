'use client'

import Link from 'next/link'
import { MessageSquare, Clock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { cn, timeAgo } from '@/lib/utils'
import type { InboxItem } from '@/types/database'

interface InboxKanbanProps {
  items: InboxItem[]
}

const COLUMNS = [
  { key: 'active', label: 'Active', color: 'border-t-green-500 bg-green-50/30' },
  { key: 'in_progress', label: 'In Progress', color: 'border-t-blue-500 bg-blue-50/30' },
  { key: 'waiting_on_customer', label: 'Waiting', color: 'border-t-amber-500 bg-amber-50/30' },
  { key: 'escalated', label: 'Escalated', color: 'border-t-red-500 bg-red-50/30' },
  { key: 'resolved', label: 'Resolved', color: 'border-t-teal-500 bg-teal-50/30' },
]

function cleanName(raw: string | null): string {
  if (!raw) return 'Unknown'
  return raw.replace(/<[^>]+>/g, '').replace(/^["']+|["']+$/g, '').trim() || 'Unknown'
}

export function InboxKanban({ items }: InboxKanbanProps) {
  // Group items by conversation status
  const grouped: Record<string, InboxItem[]> = {}
  COLUMNS.forEach(c => { grouped[c.key] = [] })

  items.forEach(item => {
    const status = item.conversation_status || 'active'
    if (grouped[status]) grouped[status].push(item)
    else grouped['active'].push(item)
  })

  return (
    <div className="flex gap-3 overflow-x-auto pb-4 min-h-[400px]">
      {COLUMNS.map(col => (
        <div key={col.key} className={cn('flex-shrink-0 w-64 rounded-xl border-t-4 border border-gray-200 flex flex-col', col.color)}>
          {/* Column header */}
          <div className="px-3 py-2.5 border-b border-gray-200 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">{col.label}</span>
            <span className="rounded-full bg-white border border-gray-200 px-2 py-0.5 text-xs font-bold text-gray-500">
              {grouped[col.key].length}
            </span>
          </div>

          {/* Cards */}
          <div className="flex-1 overflow-y-auto p-2 space-y-2 max-h-[500px]">
            {grouped[col.key].length === 0 && (
              <p className="text-xs text-gray-400 text-center py-4">No conversations</p>
            )}
            {grouped[col.key].length > 20 && (
              <p className="text-xs text-center text-amber-600 bg-amber-50 rounded py-1 mb-1">
                Showing 20 of {grouped[col.key].length}
              </p>
            )}
            {grouped[col.key].slice(0, 20).map(item => (
              <Link
                key={item.id}
                href={`/conversations/${item.conversation_id}`}
                className="block rounded-lg bg-white border border-gray-200 p-3 hover:shadow-md hover:border-teal-300 transition-all group"
              >
                <div className="flex items-center gap-2 mb-1">
                  <ChannelIcon channel={item.channel} size={14} />
                  <span className="text-sm font-medium text-gray-800 truncate group-hover:text-teal-700">
                    {cleanName(item.sender_name)}
                  </span>
                  {item.channel === 'teams' && (
                    <span className="shrink-0 rounded bg-indigo-50 px-1 py-0 text-[8px] font-bold text-indigo-600">Teams</span>
                  )}
                </div>
                <p className="text-[11px] text-gray-400 truncate mb-1">
                  {(item.account_name || '').replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '')}
                </p>
                <p className="text-xs text-gray-500 truncate mb-2">
                  {item.subject_or_preview?.substring(0, 60) || 'No preview'}
                </p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    {item.category && <Badge variant="default" size="sm">{item.category}</Badge>}
                  </div>
                  <span className="text-[10px] text-gray-400 flex items-center gap-0.5">
                    <Clock className="h-2.5 w-2.5" />
                    {timeAgo(item.timestamp)}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
