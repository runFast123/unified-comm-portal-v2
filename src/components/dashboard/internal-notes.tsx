'use client'

import { useState, useEffect, useCallback } from 'react'
import { StickyNote, Send, Pin, Clock, User, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase-client'

interface Note {
  id: string
  text: string
  author: string
  timestamp: string
  pinned: boolean
}

interface InternalNotesProps {
  conversationId: string
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

export function InternalNotes({ conversationId }: InternalNotesProps) {
  const [notes, setNotes] = useState<Note[]>([])
  const [newNoteText, setNewNoteText] = useState('')
  const [useSupabase, setUseSupabase] = useState(true)
  const [loading, setLoading] = useState(true)

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
          const mapped: Note[] = (data || []).map((row: any) => ({
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

  const handleAddNote = useCallback(async () => {
    if (!newNoteText.trim()) return

    const note: Note = {
      id: crypto.randomUUID(),
      text: newNoteText.trim(),
      author: 'Agent',
      timestamp: new Date().toISOString(),
      pinned: false,
    }

    if (useSupabase) {
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
        // Fall back to localStorage
        setUseSupabase(false)
      }
    }

    const updated = [note, ...notes]
    setNotes(updated)
    if (!useSupabase) {
      persistLocal(updated)
    }
    setNewNoteText('')
  }, [newNoteText, notes, useSupabase, conversationId, persistLocal])

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
      <div className="px-4 py-3 border-b border-amber-100">
        <div className="flex gap-2">
          <input
            type="text"
            value={newNoteText}
            onChange={(e) => setNewNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleAddNote()
              }
            }}
            placeholder="Add an internal note..."
            className="flex-1 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-amber-300 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
          />
          <Button
            size="sm"
            variant="primary"
            className="bg-amber-600 hover:bg-amber-700 focus-visible:ring-amber-500"
            onClick={handleAddNote}
            disabled={!newNoteText.trim()}
          >
            <Send size={14} />
            Add
          </Button>
        </div>
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
                className={`px-4 py-2.5 group transition-colors ${
                  note.pinned
                    ? 'bg-amber-100/60 border-l-2 border-l-amber-400'
                    : 'hover:bg-amber-50/80'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm text-gray-800 leading-relaxed flex-1">
                    {note.text}
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
                <div className="mt-1 flex items-center gap-3 text-[10px] text-amber-500">
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
