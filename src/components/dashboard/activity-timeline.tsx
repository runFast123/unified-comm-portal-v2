'use client'

/**
 * Activity timeline — chronological feed of every event on a conversation.
 *
 * Backed by GET /api/conversations/[id]/timeline, which calls the
 * `conversation_timeline(uuid)` Postgres function. Source data is unioned
 * from `messages`, `ai_replies`, and `audit_log` (entity_type='conversation').
 *
 * UX:
 *   - Vertical list with colored dots + connecting line.
 *   - Icon + color derived from `event_type` so new audited actions show up
 *     automatically with sensible defaults — no need to update this file
 *     every time a new audit action is introduced.
 *   - Default render shows the latest 10 events (most recent first); a
 *     "Show all (N)" button expands the full feed.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Bot,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  MessageSquarePlus,
  Tag,
  UserCheck,
  UserMinus,
  Zap,
} from 'lucide-react'

interface TimelineEvent {
  ts: string
  event_type: string
  actor_user_id: string | null
  actor_label: string
  summary: string
  details: Record<string, unknown> | null
}

interface ActivityTimelineProps {
  conversationId: string
  /** Show first this many events; the rest collapse behind a "Show all" toggle. */
  initialVisible?: number
}

/**
 * Decorations per event_type. Keys here are matched exactly; anything
 * unmatched falls back to `defaultDecoration` so new audit actions render
 * cleanly without code changes.
 */
function decorationFor(eventType: string): {
  Icon: React.ComponentType<{ className?: string }>
  dotClass: string
  ringClass: string
  label: string
} {
  switch (eventType) {
    case 'message_inbound':
      return {
        Icon: ArrowDownLeft,
        dotClass: 'bg-blue-500',
        ringClass: 'ring-blue-100',
        label: 'Customer message',
      }
    case 'message_outbound':
      return {
        Icon: ArrowUpRight,
        dotClass: 'bg-teal-500',
        ringClass: 'ring-teal-100',
        label: 'Reply sent',
      }
    case 'ai_draft':
      return {
        Icon: Bot,
        dotClass: 'bg-purple-500',
        ringClass: 'ring-purple-100',
        label: 'AI draft',
      }
    case 'conversation.snoozed':
      return {
        Icon: Clock,
        dotClass: 'bg-amber-500',
        ringClass: 'ring-amber-100',
        label: 'Snoozed',
      }
    case 'conversation.unsnoozed':
      return {
        Icon: Zap,
        dotClass: 'bg-amber-400',
        ringClass: 'ring-amber-100',
        label: 'Unsnoozed',
      }
    case 'conversation.status_changed':
    case 'conversation_status_changed':
      return {
        Icon: Activity,
        dotClass: 'bg-yellow-500',
        ringClass: 'ring-yellow-100',
        label: 'Status changed',
      }
    case 'conversation.assigned':
    case 'conversation_assigned':
      return {
        Icon: UserCheck,
        dotClass: 'bg-indigo-500',
        ringClass: 'ring-indigo-100',
        label: 'Assigned',
      }
    case 'conversation.unassigned':
    case 'conversation_unassigned':
      return {
        Icon: UserMinus,
        dotClass: 'bg-gray-400',
        ringClass: 'ring-gray-100',
        label: 'Unassigned',
      }
    case 'conversation.note_added':
      return {
        Icon: MessageSquarePlus,
        dotClass: 'bg-slate-500',
        ringClass: 'ring-slate-100',
        label: 'Internal note',
      }
    case 'conversation.tagged':
    case 'conversation.tag_added':
    case 'conversation.tag_removed':
      return {
        Icon: Tag,
        dotClass: 'bg-pink-500',
        ringClass: 'ring-pink-100',
        label: 'Tagged',
      }
    case 'conversation_escalated':
    case 'conversation.escalated':
      return {
        Icon: AlertCircle,
        dotClass: 'bg-red-500',
        ringClass: 'ring-red-100',
        label: 'Escalated',
      }
    default:
      return {
        Icon: Activity,
        dotClass: 'bg-gray-400',
        ringClass: 'ring-gray-100',
        label: prettifyEventType(eventType),
      }
  }
}

/** Turns 'conversation.status_changed' into 'Status changed'. */
function prettifyEventType(t: string): string {
  const tail = t.includes('.') ? t.split('.').slice(1).join('.') : t
  const cleaned = tail.replace(/[._]+/g, ' ').trim()
  if (!cleaned) return t
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Date.now() - then
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatAbsolute(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function ActivityTimeline({
  conversationId,
  initialVisible = 10,
}: ActivityTimelineProps) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const res = await fetch(`/api/conversations/${conversationId}/timeline`)
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}))
          throw new Error(payload.error || `Request failed (${res.status})`)
        }
        const json = (await res.json()) as { events: TimelineEvent[] }
        if (!cancelled) setEvents(json.events ?? [])
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load timeline')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [conversationId])

  // Show most-recent first — matches user mental model when scanning a feed.
  const ordered = useMemo(() => {
    if (!events) return []
    return [...events].sort((a, b) => {
      const ta = new Date(a.ts).getTime()
      const tb = new Date(b.ts).getTime()
      return tb - ta
    })
  }, [events])

  const visible = expanded ? ordered : ordered.slice(0, initialVisible)
  const hiddenCount = Math.max(0, ordered.length - visible.length)

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 inline-flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-gray-500" />
          Activity
        </h3>
        {events && events.length > 0 && (
          <span className="text-[11px] text-gray-400">{events.length} events</span>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-gray-400 py-3">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading activity…
        </div>
      )}

      {error && !loading && (
        <p className="text-xs text-red-600 py-2">{error}</p>
      )}

      {!loading && !error && ordered.length === 0 && (
        <p className="text-xs text-gray-400 py-2">No activity yet.</p>
      )}

      {!loading && !error && visible.length > 0 && (
        <ol className="relative space-y-4">
          {/* Vertical connector line — sits behind the dots. */}
          <span
            aria-hidden
            className="absolute left-[10px] top-2 bottom-2 w-px bg-gray-200"
          />
          {visible.map((ev, idx) => {
            const deco = decorationFor(ev.event_type)
            const Icon = deco.Icon
            return (
              <li key={`${ev.ts}-${idx}`} className="relative pl-7">
                <span
                  className={`absolute left-0 top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full ring-2 ${deco.ringClass} ${deco.dotClass}`}
                  aria-hidden
                >
                  <Icon className="h-3 w-3 text-white" />
                </span>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-gray-800">
                    {deco.label}
                  </span>
                  <span
                    className="text-[10px] text-gray-400 shrink-0"
                    title={formatAbsolute(ev.ts)}
                  >
                    {formatRelative(ev.ts)}
                  </span>
                </div>
                <p className="text-[11px] text-gray-500 mt-1">
                  <span className="font-medium text-gray-600">{ev.actor_label}</span>
                  {ev.summary ? <span className="text-gray-400"> — </span> : null}
                  {ev.summary && (
                    <span className="text-gray-500 break-words">
                      {ev.summary}
                    </span>
                  )}
                </p>
              </li>
            )
          })}
        </ol>
      )}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 inline-flex items-center gap-1 text-xs text-teal-700 hover:text-teal-800"
        >
          <ChevronDown className="h-3 w-3" /> Show all ({hiddenCount} more)
        </button>
      )}
      {expanded && ordered.length > initialVisible && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-3 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
        >
          <ChevronUp className="h-3 w-3" /> Collapse
        </button>
      )}
    </div>
  )
}
