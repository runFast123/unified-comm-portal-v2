'use client'

import { useState, useMemo } from 'react'
import { InboxRow } from '@/components/inbox/inbox-row'
import { Select } from '@/components/ui/select'
import type { InboxItem } from '@/types/database'

type SortKey = 'time_waiting' | 'priority' | 'channel'

const sortOptions = [
  { value: 'time_waiting', label: 'Time Waiting' },
  { value: 'priority', label: 'Priority' },
  { value: 'channel', label: 'Channel' },
]

const priorityOrder: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
}

interface InboxListProps {
  items: InboxItem[]
  onItemClick?: (item: InboxItem) => void
  selectedItemId?: string | null
  selectedIds?: Set<string>
  onSelectionChange?: (ids: Set<string>) => void
}

export function InboxList({ items, onItemClick, selectedItemId, selectedIds: externalSelectedIds, onSelectionChange }: InboxListProps) {
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<string>>(new Set())
  const [sortBy, setSortBy] = useState<SortKey>('time_waiting')

  // Use external selection if provided, otherwise use internal
  const selectedIds = externalSelectedIds ?? internalSelectedIds
  const setSelectedIds = onSelectionChange
    ? (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
        if (typeof updater === 'function') {
          const next = updater(selectedIds)
          onSelectionChange(next)
        } else {
          onSelectionChange(updater)
        }
      }
    : (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
        if (typeof updater === 'function') {
          setInternalSelectedIds(updater)
        } else {
          setInternalSelectedIds(updater)
        }
      }

  const sortedItems = useMemo(() => {
    const sorted = [...items]
    switch (sortBy) {
      case 'time_waiting':
        sorted.sort(
          (a, b) => new Date(a.time_waiting).getTime() - new Date(b.time_waiting).getTime()
        )
        break
      case 'priority':
        sorted.sort(
          (a, b) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3)
        )
        break
      case 'channel':
        sorted.sort((a, b) => a.channel.localeCompare(b.channel))
        break
    }
    return sorted
  }, [items, sortBy])

  const handleSelect = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return next
    })
  }

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(items.map((item) => item.id)))
    } else {
      setSelectedIds(new Set())
    }
  }

  const allSelected = items.length > 0 && selectedIds.size === items.length
  const someSelected = selectedIds.size > 0 && selectedIds.size < items.length

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      {/* List header */}
      <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-5 py-3">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected
            }}
            onChange={(e) => handleSelectAll(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
          />
          <span className="text-sm text-gray-600">
            {selectedIds.size > 0
              ? `${selectedIds.size} selected`
              : `${items.length} messages`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Sort by:</span>
          <div className="w-36">
            <Select
              options={sortOptions}
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="py-1.5 text-xs"
            />
          </div>
        </div>
      </div>

      {/* Rows */}
      {sortedItems.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-gray-500">
          No messages match your filters.
        </div>
      ) : (
        sortedItems.map((item) => (
          <InboxRow
            key={item.id}
            item={item}
            selected={selectedIds.has(item.id)}
            onSelect={handleSelect}
            onItemClick={onItemClick}
            isActive={selectedItemId === item.id}
          />
        ))
      )}
    </div>
  )
}
