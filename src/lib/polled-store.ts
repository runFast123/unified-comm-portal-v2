/**
 * A shared, deduplicated polling store.
 *
 * THE THREE PROBLEMS THIS EXISTS FOR (all measured in the header bells):
 *
 *  1. DOUBLE MOUNTING. dashboard-shell renders <MentionsBell/> and
 *     <NotificationCenter/> twice — once in the mobile header (`md:hidden`) and
 *     once in the desktop header. `md:hidden` hides one with CSS, but React
 *     still MOUNTS it, so every timer ran twice and every user made double the
 *     background requests, on every page, forever. Keying the poll loop by a
 *     string means N mounted components share exactly ONE loop.
 *
 *  2. NO VISIBILITY GATING. Only BackgroundPoller checked `document.hidden`;
 *     the bells polled forever in a backgrounded tab. Here the timer tick is
 *     skipped while hidden, and becoming visible triggers an immediate catch-up
 *     fetch if the data is stale — so a returning user sees fresh data faster
 *     than before, while an idle tab costs nothing.
 *
 *  3. NO IN-FLIGHT GUARD. A slow request could overlap the next tick and stack
 *     up. One fetch per key at a time, always.
 *
 * Framework-free on purpose: the React binding is a thin wrapper (see
 * src/hooks/use-polled.ts) so this logic is unit-testable without a DOM.
 */

export interface PolledState<T> {
  data: T | undefined
  loading: boolean
}

type Listener<T> = (state: PolledState<T>) => void

interface Store<T> {
  key: string
  fetcher: () => Promise<T>
  intervalMs: number
  isHidden: () => boolean
  data: T | undefined
  loading: boolean
  inFlight: boolean
  lastFetchedAt: number
  timer: ReturnType<typeof setInterval> | null
  listeners: Set<Listener<T>>
}

const stores = new Map<string, Store<unknown>>()

/** Default visibility probe — always "visible" outside a browser. */
function defaultIsHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function emit<T>(store: Store<T>): void {
  const snapshot: PolledState<T> = { data: store.data, loading: store.loading }
  for (const l of store.listeners) l(snapshot)
}

async function runFetch<T>(store: Store<T>): Promise<void> {
  // One in-flight request per key. A slow endpoint must not let ticks stack.
  if (store.inFlight) return
  store.inFlight = true
  store.loading = true
  emit(store)
  try {
    store.data = await store.fetcher()
    store.lastFetchedAt = Date.now()
  } catch {
    // Swallow: a poll failure is not worth breaking a header bell over. The
    // previous data stays visible rather than flashing empty.
  } finally {
    store.inFlight = false
    store.loading = false
    emit(store)
  }
}

function startTimer<T>(store: Store<T>): void {
  if (store.timer) return
  store.timer = setInterval(() => {
    // Skip work entirely while the tab is backgrounded.
    if (store.isHidden()) return
    void runFetch(store)
  }, store.intervalMs)
}

function stopTimer<T>(store: Store<T>): void {
  if (!store.timer) return
  clearInterval(store.timer)
  store.timer = null
}

// One visibility listener for ALL stores, bound lazily on first use.
let visibilityBound = false
function bindVisibility(): void {
  if (visibilityBound) return
  if (typeof document === 'undefined') return
  visibilityBound = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') return
    // Back in view: catch up anything that went stale while we were away.
    for (const store of stores.values()) {
      if (store.listeners.size === 0) continue
      if (Date.now() - store.lastFetchedAt >= store.intervalMs) void runFetch(store)
    }
  })
}

export interface SubscribeOptions<T> {
  key: string
  fetcher: () => Promise<T>
  intervalMs: number
  /** Injectable for tests; defaults to document.visibilityState. */
  isHidden?: () => boolean
}

/**
 * Subscribe to a polled resource. The FIRST subscriber for a key starts the
 * loop and fetches immediately; later subscribers attach to the same loop and
 * get the current value straight away. The LAST unsubscribe stops the timer.
 *
 * Returns an unsubscribe function.
 */
export function subscribePolled<T>(
  opts: SubscribeOptions<T>,
  listener: Listener<T>
): () => void {
  bindVisibility()

  let store = stores.get(opts.key) as Store<T> | undefined
  if (!store) {
    store = {
      key: opts.key,
      fetcher: opts.fetcher,
      intervalMs: opts.intervalMs,
      isHidden: opts.isHidden ?? defaultIsHidden,
      data: undefined,
      loading: false,
      inFlight: false,
      lastFetchedAt: 0,
      timer: null,
      listeners: new Set(),
    }
    stores.set(opts.key, store as Store<unknown>)
  }

  store.listeners.add(listener)
  // Hand the newcomer whatever we already have, so a second mount never
  // triggers a duplicate request just to populate itself.
  listener({ data: store.data, loading: store.loading })

  if (store.listeners.size === 1) {
    startTimer(store)
    void runFetch(store)
  }

  return () => {
    store!.listeners.delete(listener)
    if (store!.listeners.size === 0) stopTimer(store!)
  }
}

/** Force an immediate refresh for a key (e.g. after a mutation). */
export async function refreshPolled(key: string): Promise<void> {
  const store = stores.get(key)
  if (store) await runFetch(store)
}

/** Optimistically replace the cached value and notify every subscriber. */
export function setPolledData<T>(key: string, updater: (current: T | undefined) => T): void {
  const store = stores.get(key) as Store<T> | undefined
  if (!store) return
  store.data = updater(store.data)
  emit(store)
}

/** Test-only introspection/reset. */
export const __polledInternals = {
  activeTimers: () => Array.from(stores.values()).filter((s) => s.timer !== null).length,
  subscriberCount: (key: string) => stores.get(key)?.listeners.size ?? 0,
  reset: () => {
    for (const s of stores.values()) stopTimer(s)
    stores.clear()
    visibilityBound = false
  },
}
