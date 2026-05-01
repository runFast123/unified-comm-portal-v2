/**
 * Cron: garbage-collect stale time-tracking sessions.
 *
 * Runs every 5 minutes. Closes any `conversation_time_entries` row whose
 * last heartbeat (`ended_at`, or `started_at` if never heartbeated) is
 * older than `STALE_THRESHOLD_SECONDS` — these are presumed abandoned
 * (user closed the tab without graceful shutdown, network failed, etc.).
 *
 * The duration billed for each closed-by-GC row is "started_at -> last
 * known alive moment" — we don't credit users for the 5-minute grace
 * window after the heartbeat actually stopped.
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

    const durationMs = Date.now() - startedAt
    logInfo('system', 'time_gc_end', 'garbage-collect cron finished', {
      request_id: requestId,
      closed,
      failed,
      duration_ms: durationMs,
    })

    recordMetric(
      'cron.garbage_collect.duration_ms',
      durationMs,
      { success: true },
      requestId
    )
    recordMetric('cron.garbage_collect.closed', closed, undefined, requestId)
    if (failed > 0) {
      recordMetric(
        'cron.garbage_collect.errors',
        failed,
        { stage: 'per_row' },
        requestId
      )
    }

    return NextResponse.json({ closed, failed, request_id: requestId })
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
