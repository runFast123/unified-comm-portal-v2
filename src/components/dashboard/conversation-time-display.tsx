'use client'

// Sidebar widget for the conversation page. Renders:
//   * total time on this conversation across all users
//   * "your time" for the current viewer
//   * top 3 contributors with their totals
//   * "Add time manually" button -> opens a modal with duration + notes
//
// All data is fetched from `GET /api/conversations/[id]/time`. The widget
// re-fetches after a successful manual entry so the totals update without
// a full page refresh.

import { useCallback, useEffect, useState } from 'react'
import { Clock, Plus, RefreshCw, ChevronRight } from 'lucide-react'
import { Modal } from '@/components/ui/modal'

interface PerUser {
  user_id: string
  user_name: string
  total_seconds: number
  entry_count: number
}

interface RecentEntry {
  id: string
  user_id: string
  user_name: string
  source: 'auto' | 'manual'
  started_at: string
  ended_at: string | null
  duration_seconds: number | null
  notes: string | null
}

interface AggregateResponse {
  conversation_id: string
  total_seconds: number
  entry_count: number
  per_user: PerUser[]
  your_seconds: number
  recent_entries: RecentEntry[]
}

function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '0m'
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMin = mins % 60
  if (hrs < 24) return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`
  const days = Math.floor(hrs / 24)
  const remHr = hrs % 24
  return remHr > 0 ? `${days}d ${remHr}h` : `${days}d`
}

export function ConversationTimeDisplay({
  conversationId,
}: {
  conversationId: string
}) {
  const [data, setData] = useState<AggregateResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/time`,
        { credentials: 'same-origin' }
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const body = (await res.json()) as AggregateResponse
      setData(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const top3 = data?.per_user.slice(0, 3) ?? []

  // Compressed-by-default per UI audit H. The two-card "Total / Your"
  // grid, top-contributors list, and manual-entry button used to all be
  // visible at once — now we show a single summary line and let the
  // user expand for the breakdown. Saves vertical real estate on the
  // common case ("how long has this been open?") while keeping every
  // function reachable.
  const totalSeconds = data?.total_seconds ?? 0
  const yourSeconds = data?.your_seconds ?? 0
  const hasContributors = top3.length > 0

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
      {/* Summary row — always visible. Click expands details. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50"
        aria-expanded={expanded}
        aria-controls="time-tracking-details"
      >
        <span className="flex items-center gap-2 min-w-0">
          <Clock className="h-4 w-4 shrink-0 text-teal-600" />
          <span className="text-sm font-semibold text-gray-900">Time tracking</span>
          <span className="text-xs text-gray-500 truncate">
            {formatDuration(totalSeconds)} total
            <span className="text-gray-300 mx-1">&middot;</span>
            <span className="text-teal-700">{formatDuration(yourSeconds)} yours</span>
          </span>
        </span>
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>

      {/* Expanded body */}
      {expanded && (
        <div id="time-tracking-details" className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-3">
          {error && (
            <p className="text-xs text-red-600" role="alert">
              {error}
            </p>
          )}

          {/* Refresh control — only visible in expanded view since the
              summary row already triggers a re-render whenever the
              parent fetches. */}
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-wide text-gray-500">Breakdown</p>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                void refresh()
              }}
              className="text-gray-400 hover:text-teal-600 transition-colors"
              title="Refresh"
              aria-label="Refresh time totals"
            >
              <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            </button>
          </div>

          {hasContributors ? (
            <ul className="space-y-1">
              {top3.map((u) => (
                <li
                  key={u.user_id}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="truncate text-gray-700">{u.user_name}</span>
                  <span className="font-mono text-gray-900 ml-2 shrink-0">
                    {formatDuration(u.total_seconds)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-gray-400 italic">
              No time logged yet. Add an entry manually below.
            </p>
          )}

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setModalOpen(true)
            }}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add time manually
          </button>
        </div>
      )}

      <ManualTimeModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        conversationId={conversationId}
        onSaved={() => {
          setModalOpen(false)
          void refresh()
        }}
      />
    </div>
  )
}

// ── Manual entry modal ────────────────────────────────────────────────

function ManualTimeModal({
  open,
  onClose,
  conversationId,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  conversationId: string
  onSaved: () => void
}) {
  const [hours, setHours] = useState('0')
  const [minutes, setMinutes] = useState('15')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Reset state each time the modal opens.
  useEffect(() => {
    if (open) {
      setHours('0')
      setMinutes('15')
      setNotes('')
      setErr(null)
    }
  }, [open])

  const handleSave = async () => {
    setErr(null)
    const h = Math.max(0, Math.floor(Number(hours) || 0))
    const m = Math.max(0, Math.floor(Number(minutes) || 0))
    const total = h * 3600 + m * 60
    if (total <= 0) {
      setErr('Duration must be greater than zero')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/time/manual`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            duration_seconds: total,
            notes: notes.trim() || undefined,
          }),
        }
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add time manually"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save entry'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Duration
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              max="24"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="w-20 rounded-md border border-gray-200 px-2 py-1.5 text-sm"
              aria-label="Hours"
            />
            <span className="text-sm text-gray-600">h</span>
            <input
              type="number"
              min="0"
              max="59"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              className="w-20 rounded-md border border-gray-200 px-2 py-1.5 text-sm"
              aria-label="Minutes"
            />
            <span className="text-sm text-gray-600">m</span>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Notes <span className="text-gray-400">(optional)</span>
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="What did you work on?"
            className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-sm"
          />
        </div>
        {err && (
          <p className="text-xs text-red-600" role="alert">
            {err}
          </p>
        )}
      </div>
    </Modal>
  )
}
