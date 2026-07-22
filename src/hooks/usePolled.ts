'use client'

import { useEffect, useState } from 'react'
import { subscribePolled, type PolledState } from '@/lib/polled-store'

/**
 * React binding for the shared polled store (src/lib/polled-store.ts).
 *
 * Every component using the same `key` shares ONE poll loop, so mounting a
 * component twice — as dashboard-shell does with the header bells, once in the
 * mobile header and once in the desktop one — no longer doubles the request
 * rate. Polling also pauses while the tab is hidden and never overlaps itself.
 *
 * NOTE ON `fetcher`: the store binds the fetcher the first time a key is used,
 * and it is deliberately NOT a dependency here — an inline arrow would change
 * identity every render and thrash the subscription. Pass a module-level
 * function or a stable useCallback.
 */
export function usePolled<T>(
  key: string,
  fetcher: () => Promise<T>,
  intervalMs: number
): PolledState<T> {
  const [state, setState] = useState<PolledState<T>>({ data: undefined, loading: false })

  useEffect(() => {
    return subscribePolled<T>({ key, fetcher, intervalMs }, setState)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intervalMs])

  return state
}
