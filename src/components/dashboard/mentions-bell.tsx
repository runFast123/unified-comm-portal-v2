'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { AtSign } from 'lucide-react'
import { MENTION_REGEX } from '@/lib/mentions'
import { usePolled } from '@/hooks/usePolled'
import { setPolledData } from '@/lib/polled-store'

interface Mention {
  id: string
  note_id: string
  conversation_id: string
  read_at: string | null
  created_at: string
  note_preview: string
  author_name: string | null
}

interface MentionsResponse {
  mentions?: Mention[]
  unread_count?: number
}

function timeAgo(dateStr: string): string {
  const now = new Date()
  const date = new Date(dateStr)
  const diff = Math.max(0, now.getTime() - date.getTime())
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Render the note preview, swapping mention tokens for `@Name`. */
function renderPreview(text: string): string {
  return text.replace(new RegExp(MENTION_REGEX.source, 'g'), '@$1')
}

const POLL_INTERVAL_MS = 60_000

/**
 * Shared poll key. dashboard-shell mounts this bell TWICE (mobile + desktop
 * header; `md:hidden` only hides one with CSS, React still mounts it), so both
 * instances must share one loop instead of each running its own timer.
 */
const MENTIONS_KEY = 'mentions'

/** Module-level so its identity is stable across renders (see usePolled). */
async function fetchMentionsList(): Promise<Mention[]> {
  try {
    const res = await fetch('/api/mentions', { credentials: 'same-origin' })
    if (!res.ok) return []
    const data = (await res.json()) as MentionsResponse
    return data.mentions || []
  } catch {
    return []
  }
}

/**
 * Mentions bell — sits in the dashboard header next to the existing
 * notification bell. Shows the count of unread `@`-mentions (last 30 days);
 * clicking the bell opens a dropdown of recent mentions, and clicking a
 * mention marks it read + navigates to the conversation.
 */
export function MentionsBell() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Shared poll loop: one request per interval no matter how many copies of this
  // bell are mounted, paused while the tab is hidden. We intentionally don't
  // subscribe to realtime — mentions are far rarer than messages, so a 60s pull
  // is plenty.
  const { data, loading } = usePolled<Mention[]>(
    MENTIONS_KEY,
    fetchMentionsList,
    POLL_INTERVAL_MS
  )
  const mentions = data ?? []

  const unreadCount = mentions.filter((m) => m.read_at == null).length

  // Click-outside to close
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleMentionClick = useCallback(
    async (m: Mention) => {
      setOpen(false)
      // Optimistically mark read; persist via API best-effort. Writing through
      // the shared store updates BOTH mounted copies of the bell at once.
      if (m.read_at == null) {
        setPolledData<Mention[]>(MENTIONS_KEY, (prev) =>
          (prev ?? []).map((x) =>
            x.id === m.id ? { ...x, read_at: new Date().toISOString() } : x
          )
        )
        try {
          await fetch(`/api/mentions?id=${encodeURIComponent(m.id)}`, {
            method: 'PATCH',
            credentials: 'same-origin',
          })
        } catch {
          /* non-critical */
        }
      }
      router.push(`/conversations/${m.conversation_id}`)
    },
    [router]
  )

  // Show at most 10 in the dropdown
  const visible = mentions.slice(0, 10)

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        aria-label={`Mentions${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <AtSign className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Recent mentions"
          className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-card shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <h3 className="text-sm font-semibold text-foreground">Mentions</h3>
            <span className="text-[11px] text-muted-foreground">
              {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
            </span>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {loading && visible.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                Loading...
              </div>
            ) : visible.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                You haven&apos;t been mentioned yet.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {visible.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => handleMentionClick(m)}
                      className={`w-full text-left px-4 py-2.5 transition-colors hover:bg-accent ${
                        m.read_at == null ? 'bg-teal-50/40' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-xs font-medium text-foreground">
                          {m.author_name || 'A teammate'}{' '}
                          <span className="font-normal text-muted-foreground">
                            mentioned you
                          </span>
                        </span>
                        {m.read_at == null && (
                          <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-red-600" />
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {renderPreview(m.note_preview)}
                      </p>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {timeAgo(m.created_at)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
