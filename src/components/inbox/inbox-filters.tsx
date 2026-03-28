'use client'

import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { ChannelType, Category, Sentiment, Priority } from '@/types/database'
import { cn } from '@/lib/utils'

export interface InboxFilters {
  channel: ChannelType | 'all'
  category: Category | 'all'
  sentiment: Sentiment | 'all'
  priority: Priority | 'all'
  search: string
}

interface InboxFiltersProps {
  filters: InboxFilters
  onChange: (filters: InboxFilters) => void
}

const channelTabs: { value: ChannelType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'teams', label: 'Teams' },
  { value: 'email', label: 'Email' },
  { value: 'whatsapp', label: 'WhatsApp' },
]

const categoryOptions = [
  { value: 'all', label: 'All Categories' },
  { value: 'Sales Inquiry', label: 'Sales Inquiry' },
  { value: 'Trouble Ticket', label: 'Trouble Ticket' },
  { value: 'Payment Issue', label: 'Payment Issue' },
  { value: 'Service Problem', label: 'Service Problem' },
  { value: 'Technical Issue', label: 'Technical Issue' },
  { value: 'Billing Question', label: 'Billing Question' },
  { value: 'Connection Issue', label: 'Connection Issue' },
  { value: 'Rate Issue', label: 'Rate Issue' },
  { value: 'General Inquiry', label: 'General Inquiry' },
]

const sentimentOptions = [
  { value: 'all', label: 'All Sentiments' },
  { value: 'positive', label: 'Positive' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'negative', label: 'Negative' },
]

const priorityOptions = [
  { value: 'all', label: 'All Priorities' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

export function InboxFiltersBar({ filters, onChange }: InboxFiltersProps) {
  const updateFilter = <K extends keyof InboxFilters>(key: K, value: InboxFilters[K]) => {
    onChange({ ...filters, [key]: value })
  }

  return (
    <div className="space-y-3">
      {/* Channel tabs */}
      <div className="flex items-center gap-1 rounded-lg bg-gray-100 p-1 overflow-x-auto">
        {channelTabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => updateFilter('channel', tab.value)}
            className={cn(
              'px-4 py-2 sm:py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap min-h-[44px] sm:min-h-0',
              filters.channel === tab.value
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-48">
          <Select
            options={categoryOptions}
            value={filters.category}
            onChange={(e) => updateFilter('category', e.target.value as Category | 'all')}
          />
        </div>
        <div className="w-[calc(50%-6px)] sm:w-40">
          <Select
            options={sentimentOptions}
            value={filters.sentiment}
            onChange={(e) => updateFilter('sentiment', e.target.value as Sentiment | 'all')}
          />
        </div>
        <div className="w-[calc(50%-6px)] sm:w-40">
          <Select
            options={priorityOptions}
            value={filters.priority}
            onChange={(e) => updateFilter('priority', e.target.value as Priority | 'all')}
          />
        </div>
        <div className="w-full sm:w-64">
          <Input
            placeholder="Search messages..."
            icon={<Search size={16} />}
            value={filters.search}
            onChange={(e) => updateFilter('search', e.target.value)}
          />
        </div>
      </div>
    </div>
  )
}
