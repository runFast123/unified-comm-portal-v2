// Tests for src/lib/polled-store.ts — the shared, deduplicated polling store.
//
// It exists to fix three measured problems in the header bells, and each has a
// test here:
//   1. DOUBLE MOUNT — dashboard-shell renders MentionsBell/NotificationCenter in
//      BOTH the mobile and desktop headers. `md:hidden` hides one with CSS but
//      React still mounts it, so every timer ran twice. N subscribers on one key
//      must produce exactly ONE loop and ONE fetch.
//   2. NO VISIBILITY GATING — the bells polled forever in a backgrounded tab.
//   3. NO IN-FLIGHT GUARD — a slow request could overlap the next tick.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  subscribePolled,
  refreshPolled,
  setPolledData,
  __polledInternals,
} from '@/lib/polled-store'

beforeEach(() => {
  __polledInternals.reset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  __polledInternals.reset()
})

/** A fetcher that counts calls and resolves to an incrementing value. */
function counter() {
  let n = 0
  const fn = vi.fn(async () => {
    n += 1
    return `v${n}`
  })
  return fn
}

describe('deduplication (the double-mount fix)', () => {
  it('two subscribers on one key share ONE timer and ONE initial fetch', async () => {
    const fetcher = counter()
    const a = vi.fn()
    const b = vi.fn()

    const un1 = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, a)
    const un2 = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, b)

    await vi.advanceTimersByTimeAsync(0)

    // The second mount must NOT trigger its own request.
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(__polledInternals.activeTimers()).toBe(1)
    expect(__polledInternals.subscriberCount('k')).toBe(2)

    un1()
    un2()
  })

  it('both subscribers receive the same data', async () => {
    const fetcher = counter()
    const a = vi.fn()
    const b = vi.fn()
    const un1 = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, a)
    const un2 = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, b)
    await vi.advanceTimersByTimeAsync(0)

    expect(a).toHaveBeenCalledWith(expect.objectContaining({ data: 'v1' }))
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ data: 'v1' }))
    un1()
    un2()
  })

  it('one tick fetches once no matter how many subscribers', async () => {
    const fetcher = counter()
    const un1 = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, vi.fn())
    const un2 = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    // Two mounted components, ONE request per interval (was two before).
    expect(fetcher).toHaveBeenCalledTimes(2)
    un1()
    un2()
  })

  it('a late subscriber gets current data immediately without refetching', async () => {
    const fetcher = counter()
    const un1 = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    const late = vi.fn()
    const un2 = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, late)
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ data: 'v1' }))
    expect(fetcher).toHaveBeenCalledTimes(1) // still one
    un1()
    un2()
  })
})

describe('lifecycle', () => {
  it('keeps polling while any subscriber remains, stops when the last leaves', async () => {
    const fetcher = counter()
    const un1 = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, vi.fn())
    const un2 = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, vi.fn())
    await vi.advanceTimersByTimeAsync(0)

    un1()
    expect(__polledInternals.activeTimers()).toBe(1) // one left, still polling

    un2()
    expect(__polledInternals.activeTimers()).toBe(0) // nobody left, timer cleared

    const before = fetcher.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).toHaveBeenCalledTimes(before) // no ticks after unmount
  })

  it('separate keys poll independently', async () => {
    const f1 = counter()
    const f2 = counter()
    const unA = subscribePolled({ key: 'a', fetcher: f1, intervalMs: 1000 }, vi.fn())
    const unB = subscribePolled({ key: 'b', fetcher: f2, intervalMs: 1000 }, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(__polledInternals.activeTimers()).toBe(2)
    expect(f1).toHaveBeenCalledTimes(1)
    expect(f2).toHaveBeenCalledTimes(1)
    unA()
    unB()
  })
})

describe('visibility gating (hidden tabs cost nothing)', () => {
  it('skips the tick while hidden, resumes when visible', async () => {
    const fetcher = counter()
    let hidden = false
    const un = subscribePolled(
      { key: 'k', fetcher, intervalMs: 1000, isHidden: () => hidden },
      vi.fn()
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1) // initial

    hidden = true
    await vi.advanceTimersByTimeAsync(5000) // five ticks, all skipped
    expect(fetcher).toHaveBeenCalledTimes(1)

    hidden = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetcher).toHaveBeenCalledTimes(2) // polling resumes
    un()
  })
})

describe('in-flight guard', () => {
  it('never runs two fetches at once for a key', async () => {
    let resolve!: (v: string) => void
    const fetcher = vi.fn(
      () => new Promise<string>((r) => { resolve = r })
    )
    const un = subscribePolled({ key: 'k', fetcher, intervalMs: 100 }, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1) // in flight, unresolved

    // Several ticks pass while the first request is still hanging.
    await vi.advanceTimersByTimeAsync(500)
    expect(fetcher).toHaveBeenCalledTimes(1) // no stacking

    resolve('done')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(fetcher).toHaveBeenCalledTimes(2) // free to poll again
    un()
  })
})

describe('robustness + helpers', () => {
  it('a failing fetch keeps the previous data instead of flashing empty', async () => {
    let shouldFail = false
    const fetcher = vi.fn(async () => {
      if (shouldFail) throw new Error('network down')
      return 'good'
    })
    const seen: unknown[] = []
    const un = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, (s) => seen.push(s.data))
    await vi.advanceTimersByTimeAsync(0)

    shouldFail = true
    await vi.advanceTimersByTimeAsync(1000)

    // Still 'good' — a poll failure must not blank the bell.
    expect(seen[seen.length - 1]).toBe('good')
    un()
  })

  it('refreshPolled forces an immediate fetch', async () => {
    const fetcher = counter()
    const un = subscribePolled({ key: 'k', fetcher, intervalMs: 100000 }, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await refreshPolled('k')
    expect(fetcher).toHaveBeenCalledTimes(2)
    un()
  })

  it('setPolledData updates every subscriber (optimistic updates)', async () => {
    const fetcher = counter()
    const a = vi.fn()
    const b = vi.fn()
    const un1 = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, a)
    const un2 = subscribePolled({ key: 'k', fetcher, intervalMs: 1000 }, b)
    await vi.advanceTimersByTimeAsync(0)

    setPolledData<string>('k', () => 'optimistic')
    expect(a).toHaveBeenLastCalledWith(expect.objectContaining({ data: 'optimistic' }))
    expect(b).toHaveBeenLastCalledWith(expect.objectContaining({ data: 'optimistic' }))
    un1()
    un2()
  })
})
