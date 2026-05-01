'use client'

// Smart inbox sidebar — left-rail filter panel that lets agents one-click
// view by AI-detected category, sentiment, urgency, channel, status, and
// assignment. Plays well with the existing inbox: writes its state to the
// URL so refreshes survive, and saved views (which share filter keys) keep
// working unchanged.
//
// Layout: collapsible drawer on mobile (off-canvas), persistent panel from
// `md:` and up. Each section is a list of clickable chips with counts.

import { useMemo } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Filter,
  X as XIcon,
  Tag,
  Smile,
  AlertTriangle,
  Inbox,
  CircleDot,
  User as UserIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  readFacetFiltersFromSearch as _readFacetFiltersFromSearch,
  writeFacetFiltersToSearch as _writeFacetFiltersToSearch,
  type FacetActiveFilters,
  type FacetFilterKey,
} from '@/lib/inbox-facets'

import type { InboxFacets } from '@/app/api/inbox/facets/route'

export type { FacetFilterKey, FacetActiveFilters } from '@/lib/inbox-facets'

interface InboxFacetsSidebarProps {
  facets: InboxFacets | null
  activeFilters: FacetActiveFilters
  onChange: (next: FacetActiveFilters) => void
  /** Toggle off-canvas drawer on mobile (when undefined sidebar always shows on md+). */
  open?: boolean
  onClose?: () => void
  /** Tracks which sections are collapsed. Optional state for callers. */
  collapsedSections?: Set<FacetFilterKey>
  onToggleSection?: (key: FacetFilterKey) => void
  /** Optional loading flag — shows skeleton chips. */
  loading?: boolean
}

interface SectionDef {
  key: FacetFilterKey
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const SECTIONS: SectionDef[] = [
  { key: 'category', label: 'Category', icon: Tag },
  { key: 'sentiment', label: 'Sentiment', icon: Smile },
  { key: 'urgency', label: 'Urgency', icon: AlertTriangle },
  { key: 'channel', label: 'Channel', icon: Inbox },
  { key: 'status', label: 'Status', icon: CircleDot },
  { key: 'assignment', label: 'Assignment', icon: UserIcon },
]

const SENTIMENT_LABELS: Record<string, string> = {
  positive: 'Positive',
  neutral: 'Neutral',
  negative: 'Negative',
}
const URGENCY_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}
const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  teams: 'Teams',
  whatsapp: 'WhatsApp',
}
const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  in_progress: 'In progress',
  waiting_on_customer: 'Waiting on customer',
  resolved: 'Resolved',
  escalated: 'Escalated',
  archived: 'Archived',
}
const ASSIGNMENT_LABELS: Record<string, string> = {
  me: 'Assigned to me',
  unassigned: 'Unassigned',
}

/**
 * Build the per-section list of chips from the facets payload. Each chip
 * has a stable `value` (used in the URL query string) and a human label.
 */
function chipsForSection(
  key: FacetFilterKey,
  facets: InboxFacets | null,
): Array<{ value: string; label: string; count: number }> {
  if (!facets) return []
  switch (key) {
    case 'category':
      return facets.categories.map((c) => ({
        value: c.name,
        label: c.name,
        count: c.count,
      }))
    case 'sentiment':
      return Object.entries(facets.sentiments).map(([value, count]) => ({
        value,
        label: SENTIMENT_LABELS[value] ?? value,
        count,
      }))
    case 'urgency':
      return Object.entries(facets.urgencies).map(([value, count]) => ({
        value,
        label: URGENCY_LABELS[value] ?? value,
        count,
      }))
    case 'channel':
      return Object.entries(facets.channels).map(([value, count]) => ({
        value,
        label: CHANNEL_LABELS[value] ?? value,
        count,
      }))
    case 'status':
      return Object.entries(facets.statuses).map(([value, count]) => ({
        value,
        label: STATUS_LABELS[value] ?? value,
        count,
      }))
    case 'assignment':
      return [
        { value: 'me', label: ASSIGNMENT_LABELS.me, count: facets.assigned_to_me },
        {
          value: 'unassigned',
          label: ASSIGNMENT_LABELS.unassigned,
          count: facets.unassigned,
        },
      ]
    default:
      return []
  }
}

export function InboxFacetsSidebar({
  facets,
  activeFilters,
  onChange,
  open,
  onClose,
  collapsedSections,
  onToggleSection,
  loading,
}: InboxFacetsSidebarProps) {
  const anyFilterActive = useMemo(
    () => Object.values(activeFilters).some((v) => !!v),
    [activeFilters],
  )

  const handleChipClick = (key: FacetFilterKey, value: string) => {
    const isActive = activeFilters[key] === value
    const next = { ...activeFilters }
    if (isActive) {
      delete next[key]
    } else {
      next[key] = value
    }
    onChange(next)
  }

  const clearAll = () => onChange({})

  // Tailwind: hidden on mobile unless `open`; always visible from md: up.
  const containerClasses = cn(
    'flex flex-col h-full w-72 shrink-0 border-r border-gray-200 bg-white',
    open === false && 'hidden md:flex',
    open === true && 'fixed inset-y-0 left-0 z-40 shadow-2xl md:static md:shadow-none md:flex',
  )

  return (
    <aside
      className={containerClasses}
      aria-label="Inbox filters"
      data-testid="inbox-facets-sidebar"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
          <Filter className="h-4 w-4 text-teal-600" />
          Filters
          {facets && (
            <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
              {facets.total}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {anyFilterActive && (
            <button
              type="button"
              onClick={clearAll}
              className="text-xs font-medium text-teal-600 hover:text-teal-800"
            >
              Clear all
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="md:hidden rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              aria-label="Close filters"
            >
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Sections */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {SECTIONS.map((section) => {
          const SIcon = section.icon
          const collapsed = collapsedSections?.has(section.key) ?? false
          const chips = chipsForSection(section.key, facets)
          // Hide entirely-empty sections when nothing is active for them.
          const sectionActiveValue = activeFilters[section.key]
          const allZero = chips.length > 0 && chips.every((c) => c.count === 0)
          if (allZero && !sectionActiveValue && !loading) return null

          return (
            <div key={section.key} className="mb-4">
              <button
                type="button"
                onClick={() => onToggleSection?.(section.key)}
                className="group flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500 hover:bg-gray-50 hover:text-gray-700"
              >
                <span className="flex items-center gap-2">
                  <SIcon className="h-3.5 w-3.5" />
                  {section.label}
                </span>
                {collapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>

              {!collapsed && (
                <ul className="mt-1 space-y-0.5">
                  {loading && chips.length === 0 && (
                    <>
                      {[0, 1, 2].map((i) => (
                        <li key={i} className="px-2 py-1.5">
                          <div className="h-4 w-full animate-pulse rounded bg-gray-100" />
                        </li>
                      ))}
                    </>
                  )}
                  {chips.map((chip) => {
                    const active = sectionActiveValue === chip.value
                    return (
                      <li key={chip.value}>
                        <button
                          type="button"
                          onClick={() => handleChipClick(section.key, chip.value)}
                          className={cn(
                            'group flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors',
                            active
                              ? 'bg-teal-50 font-medium text-teal-800'
                              : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900',
                          )}
                          aria-pressed={active}
                        >
                          <span className="truncate">{chip.label}</span>
                          <span
                            className={cn(
                              'ml-2 shrink-0 rounded-full px-2 py-0.5 text-xs',
                              active
                                ? 'bg-teal-600 text-white'
                                : 'bg-gray-100 text-gray-600 group-hover:bg-gray-200',
                            )}
                          >
                            {chip.count}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

// Re-export the URL helpers from the lib so existing callers can keep
// importing them from here.
export const readFacetFiltersFromSearch = _readFacetFiltersFromSearch
export const writeFacetFiltersToSearch = _writeFacetFiltersToSearch
