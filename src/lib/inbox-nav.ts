/**
 * Inbox → conversation "queue navigation" contract.
 *
 * When the user opens a conversation from the inbox we stash the inbox's
 * current displayed (filtered + sorted) order of conversation_ids in
 * sessionStorage. The conversation detail view reads it back to render
 * ‹ Prev / Next › buttons and to auto-advance after Resolve / Archive, so an
 * agent can clear the queue without round-tripping to the list.
 *
 * Robustness: every read/write is wrapped in try/catch — sessionStorage may be
 * unavailable (private mode, SSR, storage disabled). The contract is treated as
 * a best-effort hint, never a hard dependency: if it's missing, malformed, or
 * stale the detail view simply hides the next/prev UI and keeps its existing
 * behaviour.
 */

export const INBOX_NAV_KEY = 'inbox:nav:v1'

/** A contract older than this (ms) is considered stale and ignored. */
export const INBOX_NAV_TTL_MS = 6 * 60 * 60 * 1000 // ~6h

export interface InboxNavContract {
  /** conversation_ids in the inbox's displayed (filtered + sorted) order. */
  ids: string[]
  /** epoch ms the contract was written (used for the staleness check). */
  ts: number
}

/**
 * Persist the inbox's current displayed order. `ids` should already be the
 * conversation_ids in the order the user sees them; we dedupe defensively
 * (preserving first-seen order) and drop falsy entries.
 */
export function writeInboxNavContract(ids: Array<string | null | undefined>): void {
  try {
    if (typeof window === 'undefined') return
    const deduped: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      deduped.push(id)
    }
    if (deduped.length === 0) return
    const payload: InboxNavContract = { ids: deduped, ts: Date.now() }
    window.sessionStorage.setItem(INBOX_NAV_KEY, JSON.stringify(payload))
  } catch {
    /* sessionStorage unavailable — navigation is a best-effort hint only. */
  }
}

/**
 * Read the contract back. Returns null when it's absent, unparseable, the
 * wrong shape, or older than INBOX_NAV_TTL_MS.
 */
export function readInboxNavContract(): InboxNavContract | null {
  try {
    if (typeof window === 'undefined') return null
    const raw = window.sessionStorage.getItem(INBOX_NAV_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<InboxNavContract> | null
    if (
      !parsed ||
      !Array.isArray(parsed.ids) ||
      typeof parsed.ts !== 'number' ||
      !parsed.ids.every((id) => typeof id === 'string')
    ) {
      return null
    }
    if (Date.now() - parsed.ts > INBOX_NAV_TTL_MS) return null
    return { ids: parsed.ids, ts: parsed.ts }
  } catch {
    return null
  }
}

/**
 * Where to go after finishing the current conversation via Resolve / Archive
 * (auto-advance). Three outcomes, kept distinct so the caller can stay
 * opt-out-safe:
 *
 *   - { kind: 'next', id }   → a queue exists and there's a following
 *                              conversation; push to it.
 *   - { kind: 'inbox' }      → a queue exists but the current id is the LAST
 *                              one (or isn't in the queue); fall back to /inbox.
 *   - { kind: 'none' }       → no usable queue contract at all; the caller
 *                              should keep its existing post-action behaviour
 *                              (e.g. router.refresh()), NOT redirect.
 */
export type InboxNavTarget =
  | { kind: 'next'; id: string }
  | { kind: 'inbox' }
  | { kind: 'none' }

export function resolveInboxNavTarget(currentId: string): InboxNavTarget {
  const contract = readInboxNavContract()
  if (!contract) return { kind: 'none' }
  const index = contract.ids.indexOf(currentId)
  // A contract that doesn't include this conversation isn't a queue we're
  // navigating — treat it like "no contract" so we don't yank the user to the
  // inbox after an action they took on an unrelated deep-linked conversation.
  if (index < 0) return { kind: 'none' }
  if (index >= contract.ids.length - 1) return { kind: 'inbox' }
  return { kind: 'next', id: contract.ids[index + 1] }
}
