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

  // Collapsed pill: a thin one-line teaser that reveals the full summary on click.
  if (state.kind === 'summary' && collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-expanded={false}
        aria-label="Expand AI summary"
        className={cn(
          'group flex w-full items-center gap-2 rounded-full border border-violet-200 bg-violet-50 px-4 py-2',
          'text-left text-xs font-medium text-violet-700 shadow-sm transition-colors',
          'hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400'
        )}
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-600" />
        <span className="flex-1 truncate">
          AI summary available — click to expand
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-violet-500 transition-transform group-hover:translate-y-0.5" />
      </button>
    )
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <Sparkles size={16} className="text-violet-600" />
        <h3 className="flex-1 text-left text-sm font-semibold text-gray-900">
          Thread Summary
        </h3>
        {state.kind === 'summary' && (
          <>
            <button
              type="button"
              onClick={() => generate(true)}
              aria-label="Regenerate summary"
              title="Regenerate"
              className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-violet-700"
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-label="Collapse summary"
              title="Collapse"
              className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-violet-700"
            >
              <ChevronUp size={13} />
            </button>
          </>
        )}
      </div>

      <div className="border-t border-gray-100 px-4 py-3">
        {state.kind === 'idle' && (
          <button
            type="button"
            onClick={() => generate(false)}
            className={cn(
              'inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium',
              'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
              'transition-colors hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400'
            )}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Summarize thread
          </button>
        )}

        {state.kind === 'loading' && (
          // Skeleton placeholder — three pulse bars + a spinner row.
          <div
            role="status"
            aria-live="polite"
            aria-label="Generating summary"
            className="space-y-2"
          >
            <div className="flex items-center gap-2 text-xs text-violet-700">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Summarizing conversation...
            </div>
            <div className="space-y-1.5 rounded-xl bg-violet-50 p-3 ring-1 ring-violet-100">
              <div className="h-2.5 w-11/12 animate-pulse rounded bg-violet-200/70" />
              <div className="h-2.5 w-10/12 animate-pulse rounded bg-violet-200/70" />
              <div className="h-2.5 w-7/12 animate-pulse rounded bg-violet-200/70" />
            </div>
          </div>
        )}

        {state.kind === 'summary' && (
          <div className="space-y-2">
            <div className="rounded-xl bg-violet-50 p-3 text-sm leading-relaxed text-violet-900 ring-1 ring-violet-200">
              <p className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-violet-500">
                <span>AI summary</span>
                {state.cached && (
                  <span className="rounded-full bg-violet-200/60 px-1.5 py-px text-[9px] text-violet-700">
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
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 ring-1 ring-violet-200 transition-colors hover:bg-violet-100"
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
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 ring-1 ring-violet-200 transition-colors hover:bg-violet-100"
            >
              <RefreshCw className="h-3 w-3" />
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
