'use client'

import { useEffect, useState } from 'react'
import { timeAgo } from '@/lib/utils'

/**
 * Renders a relative-time string ("3 minutes", "2 hours") that auto-
 * refreshes every minute. Drop-in replacement for `{timeAgo(x)}` calls
 * inside client components.
 *
 * Why this exists:
 *
 *   `timeAgo()` is a pure function that calls `formatDistanceToNow` with
 *   the current time as reference. When the same client component is
 *   rendered both during SSR (request time on the server) and during
 *   hydration (later, on the client), the two reference times differ —
 *   and so do the resulting strings ("5 minutes" → "6 minutes" if
 *   hydration crosses a minute boundary). React then emits #418
 *   "Hydration failed because the initial UI does not match what was
 *   rendered on the server" on every page load.
 *
 *   `suppressHydrationWarning` tells React: text mismatches inside this
 *   element are intentional, don't warn. The interval below then keeps
 *   the displayed value fresh after mount without further user action.
 *
 * Server components can keep using the bare `timeAgo()` helper — they
 * render exactly once at request time, so there's no hydration
 * comparison to mismatch against.
 */
interface Props {
  timestamp: string | null | undefined
  className?: string
  /** Optional suffix appended after the relative time (e.g. "ago"). */
  suffix?: string
  /** Refresh interval in ms. Default 60s — frequent enough that the
   *  value doesn't visibly drift, rare enough not to wake the
   *  scheduler on every paint. */
  refreshMs?: number
}

export function TimeAgo({ timestamp, className, suffix, refreshMs = 60_000 }: Props) {
  // We don't actually use the state value — we just need a setter to
  // trigger a re-render. Bumping a counter is the lightest way.
  const [, force] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => force((n) => n + 1), refreshMs)
    return () => clearInterval(interval)
  }, [refreshMs])

  const text = timeAgo(timestamp)
  return (
    <span className={className} suppressHydrationWarning>
      {suffix ? `${text} ${suffix}` : text}
    </span>
  )
}
