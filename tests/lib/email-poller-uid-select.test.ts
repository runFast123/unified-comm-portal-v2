import { describe, it, expect } from 'vitest'
import { selectUidsToFetch } from '@/lib/email-poller'

const MAX = 100

describe('selectUidsToFetch (email poller cursor-safe UID selection)', () => {
  it('returns [] for an empty candidate set', () => {
    expect(selectUidsToFetch([], 100, MAX)).toEqual([])
  })

  it('backfill (no cursor): oldest-first, all when under cap', () => {
    expect(selectUidsToFetch([5, 1, 3, 2, 4], null, MAX)).toEqual([1, 2, 3, 4, 5])
    expect(selectUidsToFetch([5, 1, 3, 2, 4], 0, MAX)).toEqual([1, 2, 3, 4, 5])
  })

  it('incremental under cap: newest-first, all', () => {
    expect(selectUidsToFetch([11, 13, 12], 10, MAX)).toEqual([13, 12, 11])
  })

  it('incremental over cap (BURST): drains NEW oldest-first so the cursor stays contiguous', () => {
    // cursor=10, 105 new UIDs 11..115, cap 100 → fetch oldest 100 (11..110).
    const uids = Array.from({ length: 105 }, (_, i) => 11 + i)
    const sel = selectUidsToFetch(uids, 10, MAX)
    expect(sel.length).toBe(MAX)
    expect(sel[0]).toBe(11) // oldest first
    // Regression guard: the high-water-mark is 110 (contiguous), NOT the global
    // max 115 — so 111..115 stay above the cursor and are fetched next run, not
    // orphaned (the old newest-first slice jumped the cursor to 115).
    expect(Math.max(...sel)).toBe(110)
  })

  it('old reconcile UIDs never crowd out new mail under the cap', () => {
    // cursor=100; 60 already-ingested reconcile UIDs (1..60) + 50 genuinely new.
    const oldReconcile = Array.from({ length: 60 }, (_, i) => 1 + i)
    const fresh = Array.from({ length: 50 }, (_, i) => 101 + i) // 101..150
    const sel = selectUidsToFetch([...oldReconcile, ...fresh], 100, MAX)
    // 50 new ≤ cap → common branch; all 50 new are the highest UIDs, so every
    // one is kept and the cursor advances safely to 150.
    for (const u of fresh) expect(sel).toContain(u)
    expect(Math.max(...sel)).toBe(150)
  })

  it('big new backlog ignores old reconcile UIDs entirely', () => {
    const oldReconcile = [1, 2, 3] // ≤ cursor 100, already ingested
    const fresh = Array.from({ length: 150 }, (_, i) => 101 + i) // 101..250
    const sel = selectUidsToFetch([...oldReconcile, ...fresh], 100, MAX)
    expect(sel.length).toBe(MAX)
    expect(sel[0]).toBe(101)
    expect(Math.max(...sel)).toBe(200) // contiguous high-water mark
    expect(sel).not.toContain(1) // old reconcile dropped, not crowding new mail
  })
})
