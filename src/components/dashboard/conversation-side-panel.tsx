'use client'

import { useState, type ReactNode } from 'react'
import { Sparkles, Bot, Tag, Clock, StickyNote, Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUser } from '@/context/user-context'

/**
 * Right-side panel for the conversation page. Replaces the old "five
 * always-open cards stacked vertically" layout with a tab strip — every
 * tab content is mounted (just hidden when inactive) so input state
 * (typed-but-unsent notes, scroll position, fetched data) survives
 * tab switches.
 *
 * Each tab slot accepts an arbitrary ReactNode; the page renders the
 * existing widgets (AISidebar, ConversationTagPicker, etc.) and passes
 * them in unchanged.
 */
type TabId = 'summary' | 'copilot' | 'tags' | 'time' | 'notes' | 'activity'

interface Props {
  summary: ReactNode
  /**
   * The AI copilot. Optional so callers that don't grant AI access simply omit
   * it — when absent, no Copilot tab is rendered at all (rather than an empty
   * one). Placed second in the strip so it's immediately visible.
   */
  copilot?: ReactNode
  tags: ReactNode
  time: ReactNode
  notes: ReactNode
  activity: ReactNode
  /** Optional badge counts shown on the tab strip (e.g. unresolved note count). */
  notesCount?: number
  tagsCount?: number
}

const ALL_TABS: ReadonlyArray<{ id: TabId; label: string; Icon: typeof Sparkles }> = [
  { id: 'summary', label: 'Summary', Icon: Sparkles },
  { id: 'copilot', label: 'Copilot', Icon: Bot },
  { id: 'tags', label: 'Tags', Icon: Tag },
  { id: 'time', label: 'Time', Icon: Clock },
  { id: 'notes', label: 'Notes', Icon: StickyNote },
  { id: 'activity', label: 'Activity', Icon: Activity },
]

export function ConversationSidePanel({
  summary,
  copilot,
  tags,
  time,
  notes,
  activity,
  notesCount,
  tagsCount,
}: Props) {
  const { can } = useUser()
  const [active, setActive] = useState<TabId>('summary')

  const slots: Record<TabId, ReactNode> = { summary, copilot, tags, time, notes, activity }
  // Show the Copilot tab only when a copilot node was passed AND the user has AI
  // access — the same permission the /api/ai/copilot route enforces, so the UI
  // never offers a tab the API would refuse.
  const showCopilot = copilot != null && can('action:ai.compose')
  const TAB_ORDER = ALL_TABS.filter((t) => t.id !== 'copilot' || showCopilot)

  // Per-tab badge counts. We only render the badge when there's something
  // to show, so the tab strip stays quiet at rest.
  const badgeFor = (id: TabId): number | null => {
    if (id === 'notes' && notesCount && notesCount > 0) return notesCount
    if (id === 'tags' && tagsCount && tagsCount > 0) return tagsCount
    return null
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab strip — sticky at top of the side panel so it stays put
          while the panel content scrolls. */}
      <div className="sticky top-0 z-10 flex shrink-0 items-stretch border-b border-gray-200 bg-white">
        {TAB_ORDER.map(({ id, label, Icon }) => {
          const isActive = active === id
          const badge = badgeFor(id)
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActive(id)}
              className={cn(
                'relative flex flex-1 items-center justify-center gap-1.5 px-2 py-3 text-xs font-medium transition-colors',
                'focus:outline-none focus-visible:bg-teal-50',
                isActive
                  ? 'text-teal-700'
                  : 'text-gray-500 hover:text-gray-800 hover:bg-gray-50'
              )}
              aria-pressed={isActive}
              aria-label={`${label} panel`}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">{label}</span>
              {badge !== null && (
                <span
                  className={cn(
                    'inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold',
                    isActive
                      ? 'bg-teal-100 text-teal-700'
                      : 'bg-gray-100 text-gray-600'
                  )}
                >
                  {badge}
                </span>
              )}
              {/* Active-tab underline */}
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-2 -bottom-px h-0.5 rounded-t-sm bg-teal-600"
                />
              )}
            </button>
          )
        })}
      </div>

      {/* Tab content. All five panes are mounted; the inactive ones are
          `hidden` so they keep their state across tab switches. */}
      <div className="flex-1 overflow-y-auto bg-gray-50 p-5">
        {TAB_ORDER.map(({ id }) => (
          <div
            key={id}
            role="tabpanel"
            aria-hidden={active !== id}
            className={cn(active === id ? 'block' : 'hidden')}
          >
            {slots[id]}
          </div>
        ))}
      </div>
    </div>
  )
}
