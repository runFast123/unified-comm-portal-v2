'use client'

import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { InboxRow, type InboxRowHandle } from '@/components/inbox/inbox-row'
import { Select } from '@/components/ui/select'
import type { InboxItem } from '@/types/database'

/**
 * Suppress keyboard triage while the user is typing or interacting with a
 * control that owns the keystroke. Mirrors the global provider's
 * `isTypingTarget` semantics (keyboard-shortcuts.tsx) so search, the composer,
 * and buttons keep their keys.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  if (tag === 'BUTTON') return true
  return false
}

/** True when a modal/cheatsheet is open — the global provider owns Esc/`?`
 *  there, so the inbox handler must stand down. */
function isModalOpen(): boolean {
  if (typeof document === 'undefined') return false
  return !!document.querySelector('[role="dialog"][aria-modal="true"]')
}

type SortKey = 'newest' | 'time_waiting' | 'priority' | 'channel'

const sortOptions = [
  { value: 'newest', label: 'Newest' },
  { value: 'time_waiting', label: 'Longest waiting' },
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
  // Optimistic list mutations threaded down to each row (and used by the
  // keyboard `e` archive) so rows leave / update immediately. Keyed by
  // `message_id` (the inbox row's mutation key), NOT `id`.
  onItemRemoved?: (messageId: string) => void
  onItemUpdated?: (messageId: string, patch: Partial<InboxItem>) => void
}

export function InboxList({ items, onItemClick, selectedItemId, selectedIds: externalSelectedIds, onSelectionChange, onItemRemoved, onItemUpdated }: InboxListProps) {
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<string>>(new Set())
  // Default to newest-activity-first (industry standard, like Gmail/Front).
  // `timestamp` carries the conversation's latest real `received_at`.
  const [sortBy, setSortBy] = useState<SortKey>('newest')

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
      case 'newest':
        // Most recent activity first. `timestamp` = latest real received_at;
        // fall back to time_waiting if a row somehow lacks it.
        sorted.sort(
          (a, b) =>
            new Date(b.timestamp || b.time_waiting).getTime() -
            new Date(a.timestamp || a.time_waiting).getTime()
        )
        break
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

  const handleSelect = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return next
    })
    // `setSelectedIds` is a fresh closure each render (it forwards to the
    // external/internal setter), so it's intentionally NOT in the deps — the
    // updater form it wraps reads the latest selection at apply time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Keyboard triage ───────────────────────────────────────────────────
  // `focusedIndex` indexes into `sortedItems` (the displayed/ordered list), so
  // j/k move through rows in the same order the user sees them. -1 = no focus.
  const [focusedIndex, setFocusedIndex] = useState(-1)
  // Per-row imperative handles so the keyboard `e` can invoke the SAME archive
  // action the hover button uses (no duplicated Supabase logic). Keyed by id.
  const rowHandles = useRef<Map<string, InboxRowHandle | null>>(new Map())
  // Row DOM nodes so the focused row can be scrolled into view. Keyed by id.
  const rowEls = useRef<Map<string, HTMLDivElement | null>>(new Map())

  // The keyboard handler reads live state through this ref so the window
  // listener can subscribe ONCE (a fresh subscription per keystroke-dependency
  // change would be wasteful and could drop a keypress mid-render).
  const kbStateRef = useRef({ sortedItems, focusedIndex, selectedIds, onItemClick, handleSelect })
  kbStateRef.current = { sortedItems, focusedIndex, selectedIds, onItemClick, handleSelect }

  // Keep focus in range as the displayed list changes (filter/sort/refetch/
  // removal). Clamp to the last row; collapse to -1 when the list empties.
  // After removing the focused row the list is one shorter, so the same index
  // now lands on what was the next row — exactly the desired behaviour.
  useEffect(() => {
    setFocusedIndex((prev) => {
      if (sortedItems.length === 0) return -1
      if (prev < 0) return prev // stay unfocused until the user presses j/k
      return Math.min(prev, sortedItems.length - 1)
    })
  }, [sortedItems])

  // Scroll the focused row into view ONLY when focus moves (j/k/↑/↓) — not when
  // the list re-renders from a background refetch, which would otherwise yank a
  // row the user has scrolled away from. Read the current list via the ref so
  // this doesn't need `sortedItems` in its deps.
  useEffect(() => {
    if (focusedIndex < 0) return
    const item = kbStateRef.current.sortedItems[focusedIndex]
    if (!item) return
    rowEls.current.get(item.id)?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Same reservations as the global provider: modifier chords belong to the
      // browser/OS, and we never fire while typing or with a modal open.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (isModalOpen()) return
      const { sortedItems, focusedIndex, selectedIds, onItemClick, handleSelect } = kbStateRef.current
      if (sortedItems.length === 0) return
      const focusedItem = focusedIndex >= 0 ? sortedItems[focusedIndex] : null

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault()
          setFocusedIndex((prev) => (prev < 0 ? 0 : Math.min(prev + 1, sortedItems.length - 1)))
          break
        case 'k':
        case 'ArrowUp':
          e.preventDefault()
          setFocusedIndex((prev) => (prev <= 0 ? 0 : prev - 1))
          break
        case 'Enter':
        case 'o':
        case 'r':
          // Open the focused conversation (reply happens in the detail view, so
          // `r` is an alias for open for now).
          if (!focusedItem) return
          e.preventDefault()
          onItemClick?.(focusedItem)
          break
        case 'x':
          // Toggle selection — integrates with the existing bulk model, which
          // keys off `item.id` (NOT message_id).
          if (!focusedItem) return
          e.preventDefault()
          handleSelect(focusedItem.id, !selectedIds.has(focusedItem.id))
          break
        case 'e':
          // Archive the focused row via its imperative handle — reuses the
          // row's exact Supabase write + toast + onItemRemoved. After removal,
          // the clamp effect keeps focus on the same index (now the next row).
          if (!focusedItem) return
          e.preventDefault()
          void rowHandles.current.get(focusedItem.id)?.archive()
          break
        // Any other key: do nothing and DON'T preventDefault (let `/`, `g`, `?`
        // etc. reach the global provider).
        default:
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

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
        sortedItems.map((item, index) => (
          // Wrapper captures the row DOM node for scrollIntoView; the imperative
          // ref on <InboxRow> exposes its archive() to the keyboard handler.
          <div
            key={item.id}
            ref={(el) => {
              if (el) rowEls.current.set(item.id, el)
              else rowEls.current.delete(item.id)
            }}
          >
            <InboxRow
              ref={(h) => {
                if (h) rowHandles.current.set(item.id, h)
                else rowHandles.current.delete(item.id)
              }}
              item={item}
              selected={selectedIds.has(item.id)}
              onSelect={handleSelect}
              onItemClick={onItemClick}
              isActive={selectedItemId === item.id}
              isFocused={index === focusedIndex}
              onItemRemoved={onItemRemoved}
              onItemUpdated={onItemUpdated}
            />
          </div>
        ))
      )}
    </div>
  )
}
