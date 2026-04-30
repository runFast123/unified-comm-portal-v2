'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * useSmartCompose — Gmail-style ghost-text suggestion for a textarea.
 *
 * Fires `/api/ai-compose` 800ms after the user pauses typing, then exposes
 * the returned continuation as `suggestion`. The host component decides
 * how/where to render the ghost text — this hook only owns the data flow.
 *
 * Smart conditions BEFORE firing:
 *   - `enabled` is true (caller controls the toggle)
 *   - `current_text.length >= 3` (avoid suggesting on empty drafts)
 *   - cursor sits at the end of the typed text (no mid-word suggestions)
 *   - the last visible char is NOT whitespace right before a period
 *     (prevents weird suggestions in the middle of a sentence)
 *   - no Send is currently in flight (`isSendInFlight === false`)
 *
 * Cancellation:
 *   - Each new keystroke aborts the in-flight fetch (AbortController) and
 *     restarts the debounce timer.
 *   - On 429 we silently disable suggestions for `RATE_LIMIT_BACKOFF_MS`
 *     so the UI stops hammering the endpoint while the limiter resets.
 */

const DEBOUNCE_MS = 800
const MIN_TEXT_LEN = 3
const RATE_LIMIT_BACKOFF_MS = 30_000

export interface UseSmartComposeOptions {
  conversationId: string
  /** Current textarea value. */
  text: string
  /** Cursor position (textarea.selectionStart). Required to know if we're at end. */
  cursorPos: number
  /** Caller-controlled master switch — when false, the hook is a no-op. */
  enabled: boolean
  /** When true, suppress suggestions because a send is being dispatched. */
  isSendInFlight?: boolean
  /** Element ref so the hook can read fresh text without re-firing on every render. */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
}

export interface UseSmartComposeResult {
  /** The current ghost text. Empty string when nothing to show. */
  suggestion: string
  /** True while a fetch is in flight. */
  isLoading: boolean
  /**
   * Accept the suggestion. Returns the new full text (current + suggestion)
   * so the caller can write it back into the textarea + state at once.
   */
  accept: () => string | null
  /** Clear the current suggestion (e.g. on user keypress, blur, etc.). */
  dismiss: () => void
}

export function useSmartCompose(opts: UseSmartComposeOptions): UseSmartComposeResult {
  const { conversationId, text, cursorPos, enabled, isSendInFlight = false } = opts
  const [suggestion, setSuggestion] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  // Track which `text` the in-flight (or last completed) request was for, so
  // a stale response can't overwrite a fresher suggestion.
  const requestForTextRef = useRef<string>('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const backoffUntilRef = useRef<number>(0)

  const dismiss = useCallback(() => {
    setSuggestion('')
    requestForTextRef.current = ''
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setIsLoading(false)
  }, [])

  const accept = useCallback((): string | null => {
    if (!suggestion) return null
    const newText = text + suggestion
    setSuggestion('')
    requestForTextRef.current = ''
    return newText
  }, [suggestion, text])

  // Master fetch loop — re-runs whenever inputs change.
  useEffect(() => {
    // Clean up any pending timer/request on every change.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }

    if (!enabled) {
      if (suggestion) setSuggestion('')
      return
    }

    if (isSendInFlight) {
      if (suggestion) setSuggestion('')
      return
    }

    // If user kept typing, the previous suggestion is stale.
    // We only KEEP the current suggestion when the typed text still equals
    // exactly what was the basis for it.
    if (suggestion && requestForTextRef.current !== text) {
      setSuggestion('')
    }

    if (text.length < MIN_TEXT_LEN) {
      return
    }

    // Cursor must be at the very end.
    if (cursorPos !== text.length) {
      return
    }

    // Avoid mid-sentence suggestions: if the previous non-trailing char looks
    // like the user is mid-word with whitespace before a period etc.
    const lastChar = text[text.length - 1]
    const beforeLast = text[text.length - 2]
    if (lastChar === '.' && beforeLast === ' ') {
      // " ." pattern — odd, skip.
      return
    }

    // Rate-limit backoff guard.
    if (Date.now() < backoffUntilRef.current) {
      return
    }

    // Don't refetch if we already have a suggestion for THIS exact text.
    if (suggestion && requestForTextRef.current === text) {
      return
    }

    const snapshot = text
    debounceRef.current = setTimeout(() => {
      const controller = new AbortController()
      abortRef.current = controller
      setIsLoading(true)

      fetch('/api/ai-compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          current_text: snapshot,
        }),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (res.status === 429) {
            // Silent backoff — stop firing for a window.
            backoffUntilRef.current = Date.now() + RATE_LIMIT_BACKOFF_MS
            return null
          }
          if (!res.ok) return null
          try {
            return (await res.json()) as { suggestion?: string | null; skipped?: boolean }
          } catch {
            return null
          }
        })
        .then((data) => {
          if (controller.signal.aborted) return
          // Only apply if the user's text hasn't changed under us.
          if (snapshot !== textRefCurrent(opts)) return
          if (!data) return
          if (data.skipped) return
          const next = (data.suggestion ?? '').toString()
          if (!next) {
            setSuggestion('')
            requestForTextRef.current = ''
            return
          }
          setSuggestion(next)
          requestForTextRef.current = snapshot
        })
        .catch(() => {
          // AbortError or network error — silent.
        })
        .finally(() => {
          if (abortRef.current === controller) abortRef.current = null
          setIsLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
    }
    // We intentionally exclude `suggestion` from deps — it's set by this
    // effect and including it would loop. The inner `requestForTextRef`
    // comparison handles staleness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, cursorPos, enabled, isSendInFlight, conversationId])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (abortRef.current) abortRef.current.abort()
    }
  }, [])

  return { suggestion, isLoading, accept, dismiss }
}

/**
 * Read the current textarea value via ref when available, otherwise fall back
 * to the prop. Lets the staleness guard work even if React re-renders
 * happened mid-flight.
 */
function textRefCurrent(opts: UseSmartComposeOptions): string {
  const live = opts.textareaRef?.current?.value
  return typeof live === 'string' ? live : opts.text
}
