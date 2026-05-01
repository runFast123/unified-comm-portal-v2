// ─── Outgoing webhook dispatcher ────────────────────────────────────
//
// `fireWebhook(eventType, payload, companyId)` finds every active
// `webhook_subscriptions` row for the given company that subscribed to
// `eventType`, then POSTs the JSON payload to each one with an HMAC-SHA256
// signature header (`X-Webhook-Signature: sha256=<hex>`).
//
// Delivery characteristics:
//   * 3 retries with exponential backoff (1s, 5s, 30s).
//   * Each attempt is recorded in `webhook_deliveries` (audit trail).
//   * After 5 consecutive failures the subscription is auto-deactivated.
//   * Designed to be called inside `after()` from request handlers so a
//     slow / dead customer endpoint never blocks the main flow.
//
// The dispatcher is intentionally self-contained — it owns the DB writes,
// the fetch, the timing — so callers only need a single line:
//
//     after(() => fireWebhook('conversation.resolved', {...}, companyId))
//
// All errors are caught internally; the function never throws to its caller.

import crypto from 'crypto'

import { createServiceRoleClient } from '@/lib/supabase-server'
import { logError, logInfo } from '@/lib/logger'

// ── Tunables ────────────────────────────────────────────────────────

/** Backoff between retry attempts (ms). Length === retry count. */
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000]

/** Per-attempt HTTP timeout. Customers' endpoints can be slow. */
const REQUEST_TIMEOUT_MS = 10_000

/** When `consecutive_failures` reaches this number, deactivate the sub. */
const DEACTIVATE_AFTER_FAILURES = 5

/** Max chars of payload preserved in `webhook_deliveries.payload_excerpt`. */
const PAYLOAD_EXCERPT_LEN = 500

// ── Types ───────────────────────────────────────────────────────────

export type WebhookEventType =
  | 'conversation.created'
  | 'conversation.resolved'
  | 'message.received'
  | 'webhook.test'
  | (string & {}) // allow callers to extend without losing autocomplete on the literals

export interface WebhookSubscriptionRow {
  id: string
  company_id: string
  url: string
  events: string[]
  signing_secret: string
  is_active: boolean
  consecutive_failures: number
}

interface DispatchOptions {
  /**
   * Inject a custom fetch impl. Used by tests; production passes nothing
   * and the global fetch is used.
   */
  fetchImpl?: typeof fetch
  /**
   * Inject a sleep impl so tests can fast-forward retries instead of
   * actually waiting 30 seconds.
   */
  sleepImpl?: (ms: number) => Promise<void>
}

// ── Signature ───────────────────────────────────────────────────────

/**
 * Compute the HMAC-SHA256 signature of the payload with the given secret,
 * formatted as the value of the `X-Webhook-Signature` header:
 *
 *     sha256=<hex>
 *
 * Pure / no IO. Exposed so tests + customer-side verifiers can call it
 * without booting the dispatcher.
 */
export function signPayload(payloadJson: string, secret: string): string {
  const hex = crypto.createHmac('sha256', secret).update(payloadJson).digest('hex')
  return `sha256=${hex}`
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Fire `eventType` to every active webhook subscription for `companyId`
 * that includes `eventType` in its `events` array. Resolves only after
 * every dispatch + retry has settled (so callers wrapping this in
 * `after()` get clean lambda lifecycle).
 *
 * Never throws. All errors are logged and persisted to webhook_deliveries.
 */
export async function fireWebhook(
  eventType: WebhookEventType,
  payload: unknown,
  companyId: string,
  opts: DispatchOptions = {},
): Promise<void> {
  if (!eventType || !companyId) return

  let subs: WebhookSubscriptionRow[] = []
  try {
    const admin = await createServiceRoleClient()
    const { data, error } = await admin
      .from('webhook_subscriptions')
      .select('id, company_id, url, events, signing_secret, is_active, consecutive_failures')
      .eq('company_id', companyId)
      .eq('is_active', true)
    if (error) {
      logError('webhook', 'sub_lookup_failed', error.message, { event_type: eventType, company_id: companyId })
      return
    }
    subs = ((data ?? []) as WebhookSubscriptionRow[]).filter((s) =>
      Array.isArray(s.events) && s.events.includes(eventType),
    )
  } catch (err) {
    logError('webhook', 'sub_lookup_failed', err instanceof Error ? err.message : 'unknown', {
      event_type: eventType,
      company_id: companyId,
    })
    return
  }

  if (subs.length === 0) return

  // Dispatch in parallel — one slow customer endpoint shouldn't delay the
  // others. Each dispatchToSubscription handles its own retries + audit.
  await Promise.allSettled(
    subs.map((sub) => dispatchToSubscription(sub, eventType, payload, opts)),
  )
}

// ── Per-subscription delivery loop ──────────────────────────────────

async function dispatchToSubscription(
  sub: WebhookSubscriptionRow,
  eventType: WebhookEventType,
  payload: unknown,
  opts: DispatchOptions,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const sleepImpl = opts.sleepImpl ?? defaultSleep

  // Body shape is stable: { event, delivered_at, data }. Customers verify
  // the signature against the raw bytes of this body.
  const body = JSON.stringify({
    event: eventType,
    delivered_at: new Date().toISOString(),
    data: payload,
  })
  const signature = signPayload(body, sub.signing_secret)
  const excerpt = body.length > PAYLOAD_EXCERPT_LEN ? body.slice(0, PAYLOAD_EXCERPT_LEN) : body

  let attemptIndex = 0 // 0-based; total attempts = 1 + RETRY_DELAYS_MS.length
  let lastStatus: number | null = null
  let lastError: string | null = null
  let success = false

  while (true) {
    const startedAt = Date.now()
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      let response: Response
      try {
        response = await fetchImpl(sub.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': signature,
            'X-Webhook-Event': eventType,
            'X-Webhook-Subscription-Id': sub.id,
            'User-Agent': 'UnifiedCommsPortal-Webhook/1.0',
          },
          body,
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeoutId)
      }

      lastStatus = response.status
      success = response.ok
      lastError = success ? null : `HTTP ${response.status}`
    } catch (err) {
      lastStatus = null
      lastError = err instanceof Error ? err.message : 'unknown fetch error'
      success = false
    }

    const duration = Date.now() - startedAt
    await recordDelivery({
      subscription_id: sub.id,
      event_type: eventType,
      payload_excerpt: excerpt,
      http_status: lastStatus,
      duration_ms: duration,
      error: lastError,
      retry_count: attemptIndex,
    })

    if (success) break
    if (attemptIndex >= RETRY_DELAYS_MS.length) break // exhausted retries

    await sleepImpl(RETRY_DELAYS_MS[attemptIndex])
    attemptIndex++
  }

  // Update the subscription bookkeeping. On success: clear failures + set
  // last_delivery_at. On failure: increment consecutive_failures and
  // deactivate when we hit the threshold.
  try {
    const admin = await createServiceRoleClient()
    if (success) {
      await admin
        .from('webhook_subscriptions')
        .update({
          last_delivery_at: new Date().toISOString(),
          consecutive_failures: 0,
        })
        .eq('id', sub.id)
      logInfo('webhook', 'delivery_ok', `Delivered ${eventType} to ${sub.url}`, {
        subscription_id: sub.id,
        company_id: sub.company_id,
        event_type: eventType,
        attempts: attemptIndex + 1,
      })
    } else {
      const nextFailures = (sub.consecutive_failures ?? 0) + 1
      const updates: Record<string, unknown> = {
        consecutive_failures: nextFailures,
        last_delivery_at: new Date().toISOString(),
      }
      if (nextFailures >= DEACTIVATE_AFTER_FAILURES) {
        updates.is_active = false
      }
      await admin.from('webhook_subscriptions').update(updates).eq('id', sub.id)
      logError('webhook', 'delivery_failed', lastError ?? 'unknown', {
        subscription_id: sub.id,
        company_id: sub.company_id,
        event_type: eventType,
        attempts: attemptIndex + 1,
        consecutive_failures: nextFailures,
        deactivated: nextFailures >= DEACTIVATE_AFTER_FAILURES,
      })
    }
  } catch (err) {
    // Final bookkeeping shouldn't crash the lambda.
    logError('webhook', 'sub_update_failed', err instanceof Error ? err.message : 'unknown', {
      subscription_id: sub.id,
      event_type: eventType,
    })
  }
}

// ── Audit helper ────────────────────────────────────────────────────

interface DeliveryRow {
  subscription_id: string
  event_type: string
  payload_excerpt: string
  http_status: number | null
  duration_ms: number
  error: string | null
  retry_count: number
}

async function recordDelivery(row: DeliveryRow): Promise<void> {
  try {
    const admin = await createServiceRoleClient()
    await admin.from('webhook_deliveries').insert(row)
  } catch (err) {
    // Audit failures are non-fatal — we already log the live result via the
    // structured logger. Don't let a missing delivery row brick the lambda.
    logError('webhook', 'delivery_audit_failed', err instanceof Error ? err.message : 'unknown', {
      subscription_id: row.subscription_id,
      event_type: row.event_type,
    })
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Test helper exports ─────────────────────────────────────────────

/**
 * Exposed for unit tests so they can reach the per-subscription loop
 * without going through `fireWebhook`'s DB lookup.
 */
export const __test = {
  dispatchToSubscription,
  RETRY_DELAYS_MS,
  DEACTIVATE_AFTER_FAILURES,
}
