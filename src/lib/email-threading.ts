/**
 * Email thread-root computation (industry standard, like Gmail/Front).
 *
 * The "thread root" is a STABLE identifier shared by every message in a
 * conversation — it does NOT change as the thread grows. We derive it, in
 * order of reliability:
 *
 *   1. Gmail `threadId` (when the Gmail API exposes it) → `gmail:<threadId>`.
 *      This is the provider's own canonical thread key and the most reliable.
 *   2. The FIRST id in the RFC 5322 `References` header. Per RFC 5322 §3.6.4,
 *      References is ordered oldest→newest, so the first entry is the id of
 *      the message that STARTED the thread — a stable root for every reply.
 *   3. `In-Reply-To` — the immediate parent. Used only when References is
 *      absent (some clients send In-Reply-To but no References).
 *   4. The message's own `Message-ID` — this message starts a brand-new thread.
 *
 * Normalization strips surrounding angle brackets and whitespace so the same
 * id always maps to the same root regardless of how the header quoted it.
 *
 * IMPORTANT: this differs from the OLD `email_thread_id` value the poller used
 * to store — that was the raw, ever-growing References chain, which is unstable
 * (it changes with every reply) and was never usable for grouping.
 */

export interface ComputeThreadRootInput {
  /** The message's own Message-ID header (mailparser `parsed.messageId`). */
  messageId?: string | null
  /** The In-Reply-To header (mailparser `parsed.inReplyTo`). */
  inReplyTo?: string | null
  /**
   * The References header. mailparser returns this as a string (possibly
   * space-separated multiple ids) OR an array of ids, depending on the source.
   */
  references?: string | string[] | null
  /** Gmail API threadId, when polling via the Gmail OAuth path. */
  gmailThreadId?: string | null
}

/**
 * Strip surrounding angle brackets + whitespace from a single message-id.
 * Returns null for empty/whitespace-only input. Exported as
 * `normalizeMessageId` so callers can store a normalized Message-ID that
 * matches the form used when computing the thread root.
 */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().replace(/^<+/, '').replace(/>+$/, '').trim()
  return trimmed.length > 0 ? trimmed : null
}

// Internal alias kept for readability in this module.
const normalizeId = normalizeMessageId

/**
 * Normalize a References value (string or array) into an ordered list of ids.
 * A string may contain multiple whitespace-separated ids; we split on runs of
 * whitespace AFTER trimming brackets per token.
 */
function parseReferences(references: string | string[] | null | undefined): string[] {
  if (!references) return []
  const tokens = Array.isArray(references)
    ? references
    : references.split(/\s+/)
  const out: string[] = []
  for (const t of tokens) {
    const norm = normalizeId(t)
    if (norm) out.push(norm)
  }
  return out
}

/**
 * Compute the stable thread root for an inbound email.
 *
 * Returns `null` only when there is genuinely nothing to key off (no Gmail
 * threadId, no References, no In-Reply-To, and no Message-ID) — callers should
 * treat a null root as "ungrouped" and fall back to their legacy matching.
 */
export function computeThreadRoot(input: ComputeThreadRootInput): string | null {
  // 1. Gmail provider thread id — most reliable when present.
  const gmail = normalizeId(input.gmailThreadId)
  if (gmail) return `gmail:${gmail}`

  // 2. First id in References = the thread originator (RFC 5322 §3.6.4).
  const refs = parseReferences(input.references)
  if (refs.length > 0) return refs[0]

  // 3. In-Reply-To = immediate parent (fallback when References is missing).
  const parent = normalizeId(input.inReplyTo)
  if (parent) return parent

  // 4. Own Message-ID = this message starts a new thread.
  const own = normalizeId(input.messageId)
  if (own) return own

  return null
}
