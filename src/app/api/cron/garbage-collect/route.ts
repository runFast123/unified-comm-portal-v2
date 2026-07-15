/**
 * Cron: garbage-collect abandoned state. Runs every 5 minutes.
 *
 * Two independent sweeps, both reclaiming work that a dead client or a dead
 * function left behind:
 *
 *   1. Stale time-tracking sessions — closes any `conversation_time_entries`
 *      row whose last heartbeat (`ended_at`, or `started_at` if never
 *      heartbeated) is older than `STALE_THRESHOLD_SECONDS`; these are presumed
 *      abandoned (user closed the tab without graceful shutdown, network
 *      failed, etc.). The duration billed for each closed-by-GC row is
 *      "started_at -> last known alive moment" — we don't credit users for the
 *      5-minute grace window after the heartbeat actually stopped.
 *
 *   2. Stranded dispatch claims — returns outbound queue rows stuck mid-claim
 *      to 'pending' (or retires them to 'failed'). Without this a reply whose
 *      dispatcher died mid-send is never sent and never surfaced: the cron
 *      won't re-pick it and the retry endpoint refuses it. See
 *      src/lib/dispatch-reaper.ts.
 *
 * The sweeps are independent — one failing must not stop the other, so each is
 * reported separately and neither throws.
 *
 * Auth: same pattern as other crons (Vercel Cron sends a Bearer header,
 * internal callers use X-Webhook-Secret). Both pass through
 * `validateWebhookSecret` with timing-safe comparison.
 */

import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { validateWebhookSecret } from '@/lib/api-helpers'
import { logError, logInfo } from '@/lib/logger'
import { getRequestId } from '@/lib/request-id'
import { recordMetric } from '@/lib/metrics'
import { garbageCollectStaleSessions } from '@/lib/time-tracking'
import { reapStaleClaims } from '@/lib/dispatch-reaper'

function authorizeCron(request: Request): boolean {
  if (validateWebhookSecret(request)) return true
  const auth = request.headers.get('authorization')
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  if (!bearer) return false
  const shim = new Request(request.url, {
    method: 'GET',
    headers: { 'x-webhook-secret': bearer },
  })
  return validateWebhookSecret(shim)
}

export async function GET(request: Request) {
  const requestId = await getRequestId()
  if (!authorizeCron(request)) {
    return NextResponse.json(
      { error: 'Unauthorized', request_id: requestId },
      { status: 401 }
    )
  }

  const startedAt = Date.now()
  logInfo('system', 'time_gc_start', 'garbage-collect cron started', {
    request_id: requestId,
  })

  try {
    const admin = await createServiceRoleClient()
    const { closed, failed } = await garbageCollectStaleSessions(admin)
    const reaped = await reapStaleClaims(admin, requestId)

    const durationMs = Date.now() - startedAt
    logInfo('system', 'time_gc_end', 'garbage-collect cron finished', {
      request_id: requestId,
      closed,
      failed,
      reaped_requeued: reaped.requeued,
      reaped_retired: reaped.retired,
      reaped_raced: reaped.raced,
      reaped_errors: reaped.errors,
      reaped_degraded: reaped.degraded,
      duration_ms: durationMs,
    })

    if (reaped.degraded) {
      // Not an error — the reaper stands down until migration 20260715120000
      // lands. Worth saying out loud: while degraded, a dispatcher that dies
      // mid-send still strands its row forever.
      logInfo(
        'system',
        'reap_stale_claims_degraded',
        'Claim reaper skipped: claim-tracking columns not present yet',
        { request_id: requestId }
      )
    }

    recordMetric(
      'cron.garbage_collect.duration_ms',
      durationMs,
      { success: true },
      requestId
    )
    recordMetric('cron.garbage_collect.closed', closed, undefined, requestId)
    // Separate series from the time-entry counters: a stranded reply is a
    // customer who never got answered, and it should be alertable on its own.
    recordMetric('cron.garbage_collect.claims_requeued', reaped.requeued, undefined, requestId)
    recordMetric('cron.garbage_collect.claims_retired', reaped.retired, undefined, requestId)
    if (failed > 0) {
      recordMetric(
        'cron.garbage_collect.errors',
        failed,
        { stage: 'per_row' },
        requestId
      )
    }
    if (reaped.errors > 0) {
      recordMetric(
        'cron.garbage_collect.errors',
        reaped.errors,
        { stage: 'reap' },
        requestId
      )
    }

    return NextResponse.json({
      closed,
      failed,
      reaped: {
        requeued: reaped.requeued,
        retired: reaped.retired,
        raced: reaped.raced,
        errors: reaped.errors,
        degraded: reaped.degraded,
        per_queue: reaped.per_queue,
      },
      request_id: requestId,
    })
  } catch (err) {
    const durationMs = Date.now() - startedAt
    const message = err instanceof Error ? err.message : 'gc failed'
    logError('system', 'time_gc_error', message, { request_id: requestId })
    recordMetric(
      'cron.garbage_collect.duration_ms',
      durationMs,
      { success: false },
      requestId
    )
    recordMetric(
      'cron.garbage_collect.errors',
      1,
      { stage: 'fatal', fatal: true },
      requestId
    )
    return NextResponse.json(
      { error: message, request_id: requestId },
      { status: 500 }
    )
  }
}

export const POST = GET
