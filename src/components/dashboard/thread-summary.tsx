'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Sparkles,
  RefreshCw,
  Loader2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface ThreadSummaryProps {
  conversationId: string
  /**
   * When true, the component fetches as soon as it mounts. The parent
   * (`conversation-thread.tsx`) only renders us for threads ≥ 5 messages,
   * so auto-fetching is the desired behavior at the call site. Default false
   * preserves the legacy "click to summarize" behavior for any other caller.
   */
  autoFetch?: boolean
  /**
   * When `defaultCollapsed` is true the pill starts collapsed once the summary
   * is loaded, requiring a click to expand. Defaults to false (expanded).
   */
  defaultCollapsed?: boolean
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'summary'; text: string; cached: boolean; skipped?: boolean }
  | { kind: 'error'; message: string }

export function ThreadSummary({
  conversationId,
  autoFetch = false,
  defaultCollapsed = false,
}: ThreadSummaryProps) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed)
  // Guard against double-fetch in React 19 strict mode dev — useEffect runs twice.
  const hasAutoFetched = useRef(false)

  const generate = useCallback(
    async (force = false) => {
      setState({ kind: 'loading' })
      try {
        const res = await fetch('/api/ai-summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: conversationId, force }),
        })

        const json = (await res.json().catch(() => null)) as
          | {
              summary?: string | null
              error?: string
              cached?: boolean
              skipped?: boolean
            }
          | null

        if (!res.ok) {
          setState({
            kind: 'error',
            message: json?.error || `Request failed (${res.status})`,
          })
          return
        }

        if (json?.summary) {
          setState({
            kind: 'summary',
            text: json.summary,
            cached: !!json.cached,
            skipped: json.skipped,
          })
        } else {
          setState({
            kind: 'error',
            message: json?.error || 'No summary was generated',
          })
        }
      } catch (err) {
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    },
    [conversationId]
  )

  // Auto-fetch on mount when requested. Reset on conversation change so
  // navigating between threads doesn't show stale data.
  useEffect(() => {
    hasAutoFetched.current = false
    setState({ kind: 'idle' })
    setCollapsed(defaultCollapsed)
  }, [conversationId, defaultCollapsed])

  useEffect(() => {
    if (!autoFetch) return
    if (hasAutoFetched.current) return
    hasAutoFetched.current = true
    void generate(false)
  }, [autoFetch, generate])

  // Collapsed: show a one-line preview of the actual summary instead of
  // the previous generic "AI summary available — click to expand". Per
  // UI audit C, users should be able to skim the gist without expanding.
  // The 4-px teal left bar marks this as an AI-generated card so the
  // "teal = AI" brand-accent semantic stays consistent across the page.
  if (state.kind === 'summary' && collapsed) {
    // Use the first sentence (or first 90 chars, whichever is shorter)
    // so the preview never wraps onto a second line at the typical
    // sidebar width of 384px - 32px padding = ~352px.
    const firstSentenceMatch = state.text.match(/^[^.!?]*[.!?](?:\s|$)/)
    const preview = firstSentenceMatch
      ? firstSentenceMatch[0].trim()
      : state.text.slice(0, 90) + (state.text.length > 90 ? '…' : '')

    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-expanded={false}
        aria-label="Expand AI summary"
        className={cn(
          'group flex w-full items-stretch overflow-hidden rounded-lg border border-teal-200 bg-card text-left shadow-sm transition-colors',
          'hover:bg-teal-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400'
        )}
      >
        {/* Teal left accent bar — visual marker for AI content */}
        <span aria-hidden="true" className="w-1 shrink-0 bg-teal-600" />
        <span className="flex flex-1 items-center gap-2 px-3 py-2.5 min-w-0">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-teal-700" />
          <span className="flex-1 min-w-0">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-teal-700">
              AI Summary
            </span>
            <span className="block text-xs leading-snug text-zinc-700 truncate">
              {preview}
            </span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-teal-600 transition-transform group-hover:translate-y-0.5" />
        </span>
      </button>
    )
  }

  // Expanded card. The 4-px teal left bar matches the collapsed
  // teaser so the "teal = AI" brand-accent semantic is consistent across
  // both states — quick visual clue that this is an AI-generated section.
  return (
    <div className="flex items-stretch overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <span aria-hidden="true" className="w-1 shrink-0 bg-teal-600" />
      <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 px-4 py-3">
        <Sparkles size={16} className="text-teal-700" />
        <h3 className="flex-1 text-left text-sm font-semibold text-foreground">
          Thread Summary
        </h3>
        {state.kind === 'summary' && (
          <>
            <button
              type="button"
              onClick={() => generate(true)}
              aria-label="Regenerate summary"
              title="Regenerate"
              className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-muted hover:text-teal-700"
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-label="Collapse summary"
              title="Collapse"
              className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-muted hover:text-teal-700"
            >
              <ChevronUp size={13} />
            </button>
          </>
        )}
      </div>

      <div className="border-t border-border px-4 py-3">
        {state.kind === 'idle' && (
          // Friendly empty state per UI audit G — small icon + one-line
          // explanation + primary action. The previous version was just
          // a bare button which read as a half-finished widget.
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-50 ring-1 ring-teal-200">
              <Sparkles className="h-5 w-5 text-teal-600" strokeWidth={1.75} />
            </span>
            <p className="max-w-[240px] text-xs text-zinc-600">
              Get a one-paragraph recap of the conversation, including the
              customer&apos;s ask and what&apos;s been promised.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => generate(false)}
              aria-label="Summarize thread"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Summarize thread
            </Button>
          </div>
        )}

        {state.kind === 'loading' && (
          // Skeleton placeholder — three pulse bars + a spinner row.
          <div
            role="status"
            aria-live="polite"
            aria-label="Generating summary"
            className="space-y-2"
          >
            <div className="flex items-center gap-2 text-xs text-teal-700">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Summarizing conversation...
            </div>
            <div className="space-y-1.5 rounded-xl bg-teal-50 p-3 ring-1 ring-teal-100">
              <div className="h-2.5 w-11/12 animate-pulse rounded bg-teal-200/70" />
              <div className="h-2.5 w-10/12 animate-pulse rounded bg-teal-200/70" />
              <div className="h-2.5 w-7/12 animate-pulse rounded bg-teal-200/70" />
            </div>
          </div>
        )}

        {state.kind === 'summary' && (
          <div className="space-y-2">
            <div className="rounded-xl bg-teal-50 p-3 text-sm leading-relaxed text-teal-900 ring-1 ring-teal-200">
              <p className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-teal-700">
                <span>AI summary</span>
                {state.cached && (
                  <span className="rounded-full bg-teal-200/60 px-1.5 py-px text-[9px] text-teal-700">
                    cached
                  </span>
                )}
              </p>
              {state.text}
            </div>
            {state.skipped && (
              <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-2 text-[11px] text-amber-800 ring-1 ring-amber-200">
                <AlertTriangle className="h-3 w-3 flex-shrink-0 mt-0.5" />
                <span>
                  AI budget exceeded for this account — showing previously cached
                  summary. Refreshes resume next month.
                </span>
              </div>
            )}
            <button
              type="button"
              onClick={() => generate(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-700 ring-1 ring-teal-200 transition-colors hover:bg-teal-100"
            >
              <RefreshCw className="h-3 w-3" />
              Regenerate
            </button>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="space-y-2">
            <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-800 ring-1 ring-amber-200">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span>{state.message}</span>
            </div>
            <button
              type="button"
              onClick={() => generate(false)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-700 ring-1 ring-teal-200 transition-colors hover:bg-teal-100"
            >
              <RefreshCw className="h-3 w-3" />
              Try again
            </button>
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
