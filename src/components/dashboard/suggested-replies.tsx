'use client'

import { useState, useEffect } from 'react'
import { Sparkles, FileText, Loader2, Check, ChevronDown } from 'lucide-react'

interface SuggestedRepliesProps {
  conversationId: string
  latestMessage: string | null
  category: string | null
}

const VISIBLE_BY_DEFAULT = 3

export function SuggestedReplies({ conversationId, latestMessage, category }: SuggestedRepliesProps) {
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([])
  const [templates, setTemplates] = useState<{ id: string; title: string; content: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [inserted, setInserted] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  // Helper that uses React's native value setter so a controlled component's
  // onChange fires. Assigning textarea.value = text directly primes React's
  // internal value tracker, after which the change event would be skipped,
  // leaving manualText empty (the original bug we just fixed).
  const setReactValue = (el: HTMLTextAreaElement, text: string): boolean => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    if (!setter) {
      // Should never happen in any modern browser. If it does, log loudly so
      // we don't silently fall back to the broken direct-assignment path.
      console.error('[SuggestedReplies] HTMLTextAreaElement.prototype value setter unavailable; cannot insert text without breaking React state.')
      return false
    }
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  const handleInsert = (text: string) => {
    // Find the manual reply textarea and insert text directly
    const textarea = document.querySelector('textarea[placeholder*="Type your reply"]') as HTMLTextAreaElement | null
    if (textarea) {
      if (!setReactValue(textarea, text)) return
      textarea.focus()
      setInserted(text)
      setTimeout(() => setInserted(null), 2000)
    } else {
      // Textarea not visible — trigger Manual Reply to open first, then copy
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        if (btn.textContent?.includes('Manual Reply')) {
          btn.click()
          // Wait for textarea to appear, then insert
          setTimeout(() => {
            const ta = document.querySelector('textarea[placeholder*="Type your reply"]') as HTMLTextAreaElement | null
            if (ta && setReactValue(ta, text)) {
              ta.focus()
            }
          }, 300)
          setInserted(text)
          setTimeout(() => setInserted(null), 2000)
          return
        }
      }
      // Last fallback: copy to clipboard
      navigator.clipboard.writeText(text)
      setInserted(text)
      setTimeout(() => setInserted(null), 2000)
    }
  }

  useEffect(() => {
    if (!latestMessage || loaded) return
    setLoading(true)
    fetch('/api/suggest-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId, message_text: latestMessage, category }),
    })
      .then(res => res.json())
      .then(data => {
        setAiSuggestions(data.ai_suggestions || [])
        setTemplates(data.templates || [])
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
      .finally(() => setLoading(false))
  }, [conversationId, latestMessage, category, loaded])

  if (!latestMessage) return null
  if (!loading && aiSuggestions.length === 0 && templates.length === 0) return null

  // Build a unified list so AI suggestions and templates compete for the
  // same "first N visible" slots — keeps the section compact even when
  // both fire. AI suggestions take priority since they're context-aware.
  type SuggestionEntry =
    | { kind: 'ai'; key: string; text: string }
    | { kind: 'template'; key: string; title: string; text: string }

  const all: SuggestionEntry[] = [
    ...aiSuggestions.map((s, i) => ({ kind: 'ai' as const, key: `ai-${i}`, text: s })),
    ...templates.map((t) => ({ kind: 'template' as const, key: `t-${t.id}`, title: t.title, text: t.content })),
  ]
  const hidden = Math.max(0, all.length - VISIBLE_BY_DEFAULT)
  const visible = expanded ? all : all.slice(0, VISIBLE_BY_DEFAULT)

  return (
    <div className="shrink-0 border-t border-gray-100 bg-gray-50/50 px-4 sm:px-6 py-4">
      {/* Section header — gives the suggestions block a clear identity
          and makes intent obvious instead of relying on icon shape. */}
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          {loading ? 'Generating suggestions…' : 'Suggested replies'}
        </p>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
      </div>

      {/* Full-width cards stacked vertically. Each card shows the full
          first sentence (no mid-sentence truncation), an icon that
          distinguishes AI (purple Sparkles) from saved templates
          (gray FileText), and a "Use this reply" affordance that fades
          in on hover. */}
      <div className="space-y-1.5">
        {visible.map((entry) => {
          const isInserted = inserted === entry.text
          const isAi = entry.kind === 'ai'
          const preview = isAi ? entry.text : entry.text
          // First sentence (or first 160 chars, whichever ends sooner).
          // Looking for the first sentence-ending punctuation followed by
          // whitespace OR the 160-char hard cap so the card never gets
          // taller than ~2 lines on a typical viewport.
          const firstSentenceMatch = preview.match(/^[^.!?]*[.!?](?:\s|$)/)
          const trimmed = firstSentenceMatch
            ? firstSentenceMatch[0].trim()
            : preview.slice(0, 160) + (preview.length > 160 ? '…' : '')

          return (
            <button
              key={entry.key}
              onClick={() => handleInsert(entry.text)}
              className="group flex w-full items-start gap-3 rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-left text-sm text-gray-700 shadow-sm transition-colors hover:border-teal-300 hover:bg-teal-50/40"
              title={`Click to insert: ${entry.text}`}
            >
              <span
                className={
                  isInserted
                    ? 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-green-100 text-green-700'
                    : isAi
                      ? 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-purple-100 text-purple-700'
                      : 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-600'
                }
              >
                {isInserted ? <Check className="h-3 w-3" /> : isAi ? <Sparkles className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
              </span>
              <span className="flex-1 min-w-0">
                {entry.kind === 'template' && (
                  <span className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                    {entry.title}
                  </span>
                )}
                <span className="block break-words leading-snug">{trimmed}</span>
              </span>
              <span className="hidden shrink-0 items-center gap-1 self-center text-[11px] font-medium text-teal-700 group-hover:flex">
                Use this reply →
              </span>
            </button>
          )
        })}
      </div>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-teal-700 hover:text-teal-800 hover:underline"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
          {expanded ? 'Show fewer' : `Show ${hidden} more`}
        </button>
      )}
    </div>
  )
}
