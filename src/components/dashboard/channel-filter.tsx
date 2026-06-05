'use client'

import { cn } from '@/lib/utils'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { Layers } from 'lucide-react'
import type { ChannelType } from '@/types/database'
import { CHANNEL_LIST } from '@/lib/channels/registry'

export type ChannelFilterValue = 'all' | ChannelType

interface ChannelFilterProps {
  activeChannel: ChannelFilterValue
  onChange: (channel: ChannelFilterValue) => void
}

// Tabs are derived from the channel registry — a new channel shows up here
// automatically, in registry order, with no edit to this file.
const tabs: { value: ChannelFilterValue; label: string }[] = [
  { value: 'all', label: 'All Channels' },
  ...CHANNEL_LIST.map((c) => ({ value: c.key, label: c.filterLabel })),
]

export function ChannelFilter({ activeChannel, onChange }: ChannelFilterProps) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
      {tabs.map((tab) => {
        const isActive = activeChannel === tab.value
        return (
          <button
            key={tab.value}
            onClick={() => onChange(tab.value)}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            {tab.value === 'all' ? (
              <Layers className="h-4 w-4" />
            ) : (
              <ChannelIcon channel={tab.value} size={16} />
            )}
            <span className="hidden sm:inline">{tab.label}</span>
          </button>
        )
      })}
    </div>
  )
}
