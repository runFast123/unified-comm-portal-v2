'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { StickyNote, Send, Pin, Clock, User, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase-client'
import { MENTION_REGEX, encodeMention } from '@/lib/mentions'

interface Note {
  id: string
  text: string
  author: string
  timestamp: string
  pinned: boolean
}

interface InternalNotesProps {
  conversationId: string
  authorName?: string
}

interface MentionUser {
  id: string
  full_name: string | null
  email: string
}

const STORAGE_KEY_PREFIX = 'conversation-notes-'

function formatNoteTime(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Render a note body, replacing `@[Display Name](uuid)` tokens with styled
 * chips and leaving the rest of the text unchanged.
 */
function renderNoteBody(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = new RegExp(MENTION_REGEX.source, 'g')
  let cursor = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) {
      out.push(text.slice(cursor, match.index))
    }
    out.push(
      <span
        key={`m-${key++}`}
        className="inline-flex items-center rounded bg-teal-100 px-1.5 py-0.5 text-xs font-medium text-teal-800"
      >
        @{match[1]}
      </span>
    )
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) {
    out.push(text.slice(cursor))
  }
  return out
}

interface MentionPopoverState {
  /** Char offset (in the textarea value) where the active `@` starts. */
  triggerStart: number
  /** Current query (text after the `@`). */
  query: string
}

export function InternalNotes({ conversationId, authorName }: InternalNotesProps) {
  const [notes, setNotes] = useState<Note[]>([])
  const [newNoteText, setNewNoteText] = useState('')
  const [useSupabase, setUseSupabase] = useState(true)
  const [loading, setLoading] = useState(true)

  // Mention autocomplete state
  const [popover, setPopover] = useState<MentionPopoverState | null>(null)
  const [suggestions, setSuggestions] = useState<MentionUser[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const searchAbortRef = useRef<AbortController | null>(null)

  // Load notes: try Supabase first, fall back to localStorage
  useEffect(() => {
    let cancelled = false

    async function loadNotes() {
      setLoading(true)
      try {
        const supabase = createClient()
        const { data, error } = await supabase
          .from('conversation_notes')
          .select('id, note_text, author_name, created_at, is_pinned')
          .eq('conversation_id', conversationId)
          .order('is_pinned', { ascending: false })
          .order('created_at', { ascending: false })

        if (error) {
          throw error
        }

        if (!cancelled) {
          const mapped: Note[] = (data || []).map((row: { id: string; note_text: string; author_name: string | null; created_at: string; is_pinned: boolean | null }) => ({
            id: row.id,
            text: row.note_text,
            author: row.author_name || 'Agent',
            timestamp: row.created_at,
            pinned: row.is_pinned || false,
          }))
          setNotes(mapped)
          setUseSupabase(true)
        }
      } catch {
        // Supabase table doesn't exist or error - fall back to localStorage
        if (!cancelled) {
          setUseSupabase(false)
          const stored = localStorage.getItem(STORAGE_KEY_PREFIX + conversationId)
          if (stored) {
            try {
              setNotes(JSON.parse(stored))
            } catch {
              setNotes([])
            }
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadNotes()
    return () => {
      cancelled = true
    }
  }, [conversationId])

  // Persist to localStorage when using fallback
  const persistLocal = useCallback(
    (updatedNotes: Note[]) => {
      localStorage.setItem(
        STORAGE_KEY_PREFIX + conversationId,
        JSON.stringify(updatedNotes)
      )
    },
    [conversationId]
  )

  // Run user-search whenever the popover query changes. Aborts in-flight
  // requests so a fast typist doesn't see stale suggestions.
  useEffect(() => {
    if (!popover) {
      setSuggestions([])
      return
    }
    if (searchAbortRef.current) searchAbortRef.current.abort()
    const ctrl = new AbortController()
    searchAbortRef.current = ctrl

    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/users/search?q=${encodeURIComponent(popover.query)}`,
          { signal: ctrl.signal, credentials: 'same-origin' }
        )
        if (!res.ok) {
          setSuggestions([])
          return
        }
        const data = (await res.json()) as { users?: MentionUser[] }
        setSuggestions(data.users || [])
        setActiveIndex(0)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setSuggestions([])
        }
      }
    }, 80)

    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [popover])

  /**
   * Inspect the textarea after every change/keystroke to figure out whether
   * the caret is inside a `@token` and, if so, what the prefix is.
   *
   * The trigger char must be at start-of-string or after whitespace so we
   * don't fire mid-word (e.g. typing an email). The query terminates at the
   * first whitespace.
   */
  const evaluateTriggerAtCaret = useCallback((value: string, caret: number) => {
    if (caret === 0) {
      setPopover(null)
      return
    }
    // Walk backward from the caret looking for an @ that opens the trigger.
    let i = caret - 1
    while (i >= 0) {
      const ch = value[i]
      if (ch === '@') {
        // Must be start-of-string or preceded by whitespace.
        if (i === 0 || /\s/.test(value[i - 1])) {
          const query = value.slice(i + 1, caret)
          // Abort if the "query" already contains whitespace — the user moved
          // past the trigger.
          if (/\s/.test(query)) {
            setPopover(null)
            return
          }
          setPopover({ triggerStart: i, query })
          return
        }
        setPopover(null)
        return
      }
      if (/\s/.test(ch)) {
        // Hit whitespace before any @ — not in a trigger.
        setPopover(null)
        return
      }
      i--
    }
    setPopover(null)
  }, [])

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value
      setNewNoteText(value)
      const caret = e.target.selectionStart ?? value.length
      evaluateTriggerAtCaret(value, caret)
    },
    [evaluateTriggerAtCaret]
  )

  const insertMention = useCallback(
    (user: MentionUser) => {
      if (!popover) return
      const display = user.full_name || user.email
      const token = encodeMention(user.id, display)
      const before = newNoteText.slice(0, popover.triggerStart)
      const caret = inputRef.current?.selectionStart ?? popover.triggerStart + 1 + popover.query.length
      const after = newNoteText.slice(caret)
      const next = `${before}${token} ${after}`
      setNewNoteText(next)
      setPopover(null)
      // Restore caret position right after the inserted token + space.
      const nextCaret = before.length + token.length + 1
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (el) {
          el.focus()
          el.setSelectionRange(nextCaret, nextCaret)
        }
      })
    },
    [popover, newNoteText]
  )

  const handleAddNote = useCallback(async () => {
    if (!newNoteText.trim()) return
    const trimmed = newNoteText.trim()
    const note: Note = {
      id: crypto.randomUUID(),
      text: trimmed,
      author: authorName || 'Agent',
      timestamp: new Date().toISOString(),
      pinned: false,
    }

    let savedViaApi = false
    if (useSupabase) {
      try {
        const res = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            conversation_id: conversationId,
            note_text: trimmed,
            author_name: authorName || null,
          }),
        })
        if (!res.ok) throw new Error(`status ${res.status}`)
        const data = (await res.json()) as {
          note?: { id: string; created_at: string }
        }
        if (data.note?.id) {
          note.id = data.note.id
          note.timestamp = data.note.created_at
        }
        savedViaApi = true
      } catch {
        // Fall back to direct supabase write (preserves the original behavior
        // when the new endpoint is unreachable, e.g. local dev without auth).
        try {
          const supabase = createClient()
          const { error } = await supabase.from('conversation_notes').insert({
            id: note.id,
            conversation_id: conversationId,
            note_text: note.text,
            author_name: note.author,
            is_pinned: false,
            created_at: note.timestamp,
          })
          if (error) throw error
        } catch {
          setUseSupabase(false)
        }
      }
    }

    const updated = [note, ...notes]
    setNotes(updated)
    if (!useSupabase && !savedViaApi) {
      persistLocal(updated)
    }
    setNewNoteText('')
    setPopover(null)
  }, [newNoteText, notes, useSupabase, conversationId, persistLocal, authorName])

  const handleTogglePin = useCallback(
    async (noteId: string) => {
      const updated = notes.map((n) =>
        n.id === noteId ? { ...n, pinned: !n.pinned } : n
      )
      // Sort: pinned first, then by timestamp descending
      updated.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      })
      setNotes(updated)

      if (useSupabase) {
        try {
          const supabase = createClient()
          const note = updated.find((n) => n.id === noteId)
          await supabase
            .from('conversation_notes')
            .update({ is_pinned: note?.pinned || false })
            .eq('id', noteId)
        } catch {
          // Silently fail for Supabase
        }
      } else {
        persistLocal(updated)
      }
    },
    [notes, useSupabase, persistLocal]
  )

  const handleDeleteNote = useCallback(
    async (noteId: string) => {
      const updated = notes.filter((n) => n.id !== noteId)
      setNotes(updated)

      if (useSupabase) {
        try {
          const supabase = createClient()
          await supabase.from('conversation_notes').delete().eq('id', noteId)
        } catch {
          // Silently fail for Supabase
        }
      } else {
        persistLocal(updated)
      }
    },
    [notes, useSupabase, persistLocal]
  )

  const showPopover = popover !== null && suggestions.length > 0

  // Memoized rendered note bodies so we don't reparse on every render.
  const renderedBodies = useMemo(() => {
    const map = new Map<string, React.ReactNode[]>()
    for (const n of notes) map.set(n.id, renderNoteBody(n.text))
    return map
  }, [notes])

  return (
    <div className="rounded-xl border border-amber-200 bg-gradient-to-b from-amber-50 to-amber-50/50 shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-amber-200 px-4 py-3">
        <StickyNote size={16} className="text-amber-600" />
        <h3 className="text-sm font-semibold text-amber-900">Internal Notes</h3>
        <span className="text-xs text-amber-500">
          ({notes.length} {notes.length === 1 ? 'note' : 'notes'})
        </span>
        {!useSupabase && (
          <span className="ml-auto text-[10px] text-amber-400 bg-amber-100 px-1.5 py-0.5 rounded">
            Local storage
          </span>
        )}
      </div>

      {/* Add note input */}
      <div className="px-4 py-4 border-b border-amber-100 relative">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={newNoteText}
            onChange={handleTextareaChange}
            onKeyDown={(e) => {
              // Mention popover navigation
              if (showPopover) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActiveIndex((i) => (i + 1) % suggestions.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  insertMention(suggestions[activeIndex])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setPopover(null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleAddNote()
              }
            }}
            onKeyUp={(e) => {
              const el = e.target as HTMLTextAreaElement
              evaluateTriggerAtCaret(el.value, el.selectionStart ?? el.value.length)
            }}
            onClick={(e) => {
              const el = e.target as HTMLTextAreaElement
              evaluateTriggerAtCaret(el.value, el.selectionStart ?? el.value.length)
            }}
            placeholder="Add an internal note... type @ to mention a teammate"
            rows={2}
            className="flex-1 resize-none rounded-lg border border-amber-200 bg-white px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-amber-300 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
          />
          <Button
            size="sm"
            variant="primary"
            className="self-start bg-amber-600 hover:bg-amber-700 focus-visible:ring-amber-500"
            onClick={handleAddNote}
            disabled={!newNoteText.trim()}
          >
            <Send size={14} />
            Add
          </Button>
        </div>

        {/* Mention popover */}
        {showPopover && (
          <div
            className="absolute left-4 right-4 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg"
            role="listbox"
          >
            {suggestions.map((u, i) => (
              <button
                key={u.id}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => {
                  // Prevent the textarea blur from cancelling the popover
                  // before the click registers.
                  e.preventDefault()
                  insertMention(u)
                }}
                onMouseEnter={() => setActiveIndex(i)}
                className={`block w-full text-left px-3 py-2 text-sm transition-colors ${
                  i === activeIndex
                    ? 'bg-teal-50 text-teal-900'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <div className="font-medium">{u.full_name || u.email}</div>
                {u.full_name && (
                  <div className="text-[11px] text-gray-500">{u.email}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Notes list */}
      <div className="max-h-64 overflow-y-auto">
        {loading ? (
          <div className="px-4 py-6 text-center text-xs text-amber-400">
            Loading notes...
          </div>
        ) : notes.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-amber-400">
            No notes yet. Add one above to keep track of internal context.
          </div>
        ) : (
          <div className="divide-y divide-amber-100">
            {notes.map((note) => (
              <div
                key={note.id}
                className={`px-4 py-3.5 group transition-colors ${
                  note.pinned
                    ? 'bg-amber-100/60 border-l-2 border-l-amber-400'
                    : 'hover:bg-amber-50/80'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm text-gray-800 leading-relaxed flex-1 whitespace-pre-wrap break-words">
                    {renderedBodies.get(note.id) || note.text}
                  </p>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={() => handleTogglePin(note.id)}
                      className={`p-1 rounded transition-colors ${
                        note.pinned
                          ? 'text-amber-600 hover:text-amber-700'
                          : 'text-gray-400 hover:text-amber-600'
                      }`}
                      title={note.pinned ? 'Unpin' : 'Pin'}
                    >
                      <Pin size={12} />
                    </button>
                    <button
                      onClick={() => handleDeleteNote(note.id)}
                      className="p-1 rounded text-gray-400 hover:text-red-500 transition-colors"
                      title="Delete note"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-3 text-[10px] text-amber-500">
                  <span className="flex items-center gap-1">
                    <User size={9} />
                    {note.author}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock size={9} />
                    {formatNoteTime(note.timestamp)}
                  </span>
                  {note.pinned && (
                    <span className="flex items-center gap-0.5 text-amber-600 font-medium">
                      <Pin size={8} />
                      Pinned
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
