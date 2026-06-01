'use client'

// ─── Macro runner ────────────────────────────────────────────────────
//
// A small teal dropdown that lists this company's saved macros and applies one
// to the current conversation in a single click. Applying a macro sets status
// / tags / assignee / priority server-side — it NEVER sends a message (sending
// always requires explicit human approval in this app).
//
// If the picked macro carries a `reply_template_id`, the server returns its id
// and we hand it to `onInsertTemplate(id)` so the parent composer can INSERT
// the template text for the agent to review. Nothing is auto-sent.
//
// Props:
//   conversationId   — target conversation.
//   onApplied        — called after a successful apply (parent should refresh).
//   onInsertTemplate — optional; called with a reply_template_id when the macro
//                      references one, so the composer can insert its text.

import { useState, useCallback, useEffect, useRef } from 'react'
import { Zap, ChevronDown, Loader2, Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

interface MacroActions {
  set_status?: string
  add_tags?: string[]
  assign_to?: string | null
  set_priority?: string
  reply_template_id?: string
}

interface Macro {
  id: string
  name: string
  description: string | null
  actions: MacroActions | null
  is_active: boolean
}

interface MacroRunnerProps {
  conversationId: string
  onApplied: () => void
  onInsertTemplate?: (templateId: string) => void
}

export function MacroRunner({ conversationId, onApplied, onInsertTemplate }: MacroRunnerProps) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [macros, setMacros] = useState<Macro[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Fetch the company's macros once, the first time the dropdown opens.
  const fetchMacros = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/macros')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { macros?: Macro[] }
      const list = (data.macros ?? []).filter((m) => m.is_active !== false)
      setMacros(list)
      setLoaded(true)
    } catch (err) {
      console.error('Failed to fetch macros:', err)
      setMacros([])
      setLoaded(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && !loaded) {
      void fetchMacros()
    }
  }, [open, loaded, fetchMacros])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const handlePick = useCallback(
    async (macro: Macro) => {
      if (applyingId) return
      setApplyingId(macro.id)
      try {
        const res = await fetch(`/api/conversations/${conversationId}/apply-macro`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ macro_id: macro.id }),
        })
        if (!res.ok) {
          let errMsg = `Failed to apply macro (HTTP ${res.status})`
          try {
            const j = await res.json()
            if (j?.error) errMsg = j.error
          } catch {
            /* non-JSON */
          }
          toast.error(errMsg)
          return
        }
        const data = (await res.json()) as {
          applied?: string[]
          insert_template_id?: string | null
        }
        const applied = data.applied ?? []
        toast.success(
          applied.length > 0
            ? `Applied "${macro.name}": ${applied.join(', ')}`
            : `Applied "${macro.name}" (no changes needed)`,
        )

        // Composer hint: never sends — only offers the text for insertion.
        if (data.insert_template_id && onInsertTemplate) {
          onInsertTemplate(data.insert_template_id)
        }

        setOpen(false)
        onApplied()
      } catch (err) {
        toast.error(`Failed to apply macro: ${(err as Error).message}`)
      } finally {
        setApplyingId(null)
      }
    },
    [applyingId, conversationId, onApplied, onInsertTemplate, toast],
  )

  return (
    <div className="relative" ref={containerRef}>
      <Button
        size="sm"
        variant="secondary"
        className="bg-teal-50 text-teal-700 hover:bg-teal-100 border border-teal-200"
        onClick={() => setOpen((v) => !v)}
        title="Apply a saved macro (sets status / tags / assignee / priority — never sends)"
      >
        <Zap size={14} />
        Macros
        <ChevronDown size={12} />
      </Button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-80 rounded-xl border border-gray-200 bg-white shadow-xl z-20">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <p className="text-sm font-semibold text-gray-800">Macros</p>
            <span className="text-xs text-gray-400">{macros.length}</span>
          </div>

          <div className="max-h-72 overflow-y-auto py-1">
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 size={18} className="animate-spin text-gray-400" />
              </div>
            ) : macros.length === 0 ? (
              <div className="px-4 py-5 text-center text-xs text-gray-400">
                No macros yet. An admin can create them in settings.
              </div>
            ) : (
              macros.map((macro) => {
                const a = macro.actions ?? {}
                const chips: string[] = []
                if (a.set_status) chips.push(`status: ${a.set_status}`)
                if (a.set_priority) chips.push(`priority: ${a.set_priority}`)
                if (a.assign_to === null) chips.push('unassign')
                else if (a.assign_to) chips.push('assign')
                if (a.add_tags && a.add_tags.length > 0) {
                  chips.push(`+${a.add_tags.length} tag${a.add_tags.length === 1 ? '' : 's'}`)
                }
                if (a.reply_template_id) chips.push('insert template')
                const isApplying = applyingId === macro.id
                return (
                  <button
                    key={macro.id}
                    type="button"
                    onClick={() => handlePick(macro)}
                    disabled={applyingId !== null}
                    className="w-full px-4 py-2.5 text-left transition-colors hover:bg-teal-50 disabled:opacity-60"
                  >
                    <div className="flex items-center gap-2">
                      {isApplying ? (
                        <Loader2 size={13} className="shrink-0 animate-spin text-teal-600" />
                      ) : (
                        <Zap size={13} className="shrink-0 text-teal-500" />
                      )}
                      <span className="text-sm font-medium text-gray-800 truncate">
                        {macro.name}
                      </span>
                    </div>
                    {macro.description && (
                      <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">
                        {macro.description}
                      </p>
                    )}
                    {chips.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {chips.map((c) => (
                          <span
                            key={c}
                            className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600"
                          >
                            <Check size={9} className="text-teal-500" />
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                )
              })
            )}
          </div>

          <div className="border-t border-gray-100 px-4 py-2">
            <p className="text-[10px] leading-snug text-gray-400">
              Macros update the conversation only. They never send a message — replies
              still need your approval.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
