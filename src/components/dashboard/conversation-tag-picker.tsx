'use client'

/**
 * Conversation tag picker. Lets users add/remove tags on a conversation.
 *
 *   * Existing free-form `conversations.tags text[]` is the source of truth.
 *   * The company's `company_tags` catalog drives:
 *       - autocomplete suggestions
 *       - chip colors (free-form tags get a neutral chip)
 *
 * Free-form tags still work — typing a tag not in the catalog and pressing
 * Enter will save it just fine. The chip just renders gray.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, X } from 'lucide-react'

import { createClient } from '@/lib/supabase-client'
import { useToast } from '@/components/ui/toast'

interface CompanyTag {
  id: string
  name: string
  color: string
}

interface ConversationTagPickerProps {
  conversationId: string
  initialTags: string[]
}

const NEUTRAL = '#6b7280'

export function ConversationTagPicker({
  conversationId,
  initialTags,
}: ConversationTagPickerProps) {
  const router = useRouter()
  const { toast } = useToast()

  const [tags, setTags] = useState<string[]>(initialTags ?? [])
  const [catalog, setCatalog] = useState<CompanyTag[]>([])
  const [showInput, setShowInput] = useState(false)
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync prop → state (router.refresh() re-renders the parent which re-passes props)
  useEffect(() => { setTags(initialTags ?? []) }, [initialTags])

  // Lazy-load company catalog once on mount.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/company-tags')
        if (!res.ok) return
        const json = (await res.json()) as { tags?: CompanyTag[] }
        if (!cancelled) setCatalog(json.tags ?? [])
      } catch { /* silent */ }
    })()
    return () => { cancelled = true }
  }, [])

  // Map by lower-cased name for O(1) color lookup.
  const colorByName = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of catalog) m.set(t.name.toLowerCase(), t.color)
    return m
  }, [catalog])

  // Autocomplete suggestions: catalog entries that match the prefix and aren't
  // already on the conversation. Show up to 6.
  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase()
    if (!q) return []
    const have = new Set(tags.map((t) => t.toLowerCase()))
    return catalog
      .filter((c) => c.name.toLowerCase().includes(q) && !have.has(c.name.toLowerCase()))
      .slice(0, 6)
  }, [input, catalog, tags])

  const persist = useCallback(async (next: string[]) => {
    setSaving(true)
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from('conversations')
        .update({ tags: next })
        .eq('id', conversationId)
      if (error) throw error
      setTags(next)
      router.refresh()
    } catch (err: any) {
      toast.error('Failed to update tags: ' + err.message)
    } finally {
      setSaving(false)
    }
  }, [conversationId, router, toast])

  const addTag = useCallback(async (raw: string) => {
    const value = raw.trim()
    if (!value) return
    if (tags.some((t) => t.toLowerCase() === value.toLowerCase())) {
      // Already on the conversation — silently no-op so users don't get confused.
      setInput('')
      return
    }
    await persist([...tags, value])
    setInput('')
  }, [tags, persist])

  const removeTag = useCallback(async (value: string) => {
    await persist(tags.filter((t) => t !== value))
  }, [tags, persist])

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-700">Tags</h3>
        {!showInput && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-teal-700 hover:text-teal-800"
            onClick={() => {
              setShowInput(true)
              setTimeout(() => inputRef.current?.focus(), 0)
            }}
            disabled={saving}
          >
            <Plus className="h-3 w-3" /> Add tag
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 min-h-[24px]">
        {tags.length === 0 && !showInput && (
          <span className="text-xs text-gray-400">No tags yet</span>
        )}
        {tags.map((t) => {
          const color = colorByName.get(t.toLowerCase()) || NEUTRAL
          return (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border"
              style={{
                background: hexToBgSoft(color),
                borderColor: color,
                color,
              }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: color }}
              />
              {t}
              <button
                type="button"
                onClick={() => removeTag(t)}
                disabled={saving}
                aria-label={`Remove tag ${t}`}
                className="hover:opacity-70 disabled:opacity-50"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )
        })}
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
      </div>

      {showInput && (
        <div className="relative mt-3">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a tag and press Enter"
            className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500"
            maxLength={48}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void addTag(input)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setShowInput(false)
                setInput('')
              }
            }}
            onBlur={() => {
              // Slight delay so a click on a suggestion still fires.
              setTimeout(() => {
                setShowInput(false)
                setInput('')
              }, 150)
            }}
            disabled={saving}
          />
          {suggestions.length > 0 && (
            <ul
              className="absolute z-10 mt-1 left-0 right-0 rounded-lg border border-gray-200 bg-white shadow-lg py-1 max-h-48 overflow-y-auto"
              role="listbox"
            >
              {suggestions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      void addTag(s.name)
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-full border border-black/10"
                      style={{ background: s.color }}
                    />
                    {s.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// Local helper — see status-dropdown for the same trick. Inlined here so
// the picker is self-contained.
function hexToBgSoft(color: string): string {
  if (color.startsWith('#')) {
    const c = color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color
    const r = parseInt(c.slice(1, 3), 16)
    const g = parseInt(c.slice(3, 5), 16)
    const b = parseInt(c.slice(5, 7), 16)
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return `rgba(${r}, ${g}, ${b}, 0.12)`
    }
  }
  return 'rgba(107, 114, 128, 0.12)'
}
