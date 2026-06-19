import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { validateWebhookSecret } from '@/lib/api-helpers'
import { logError, logInfo, logWarn } from '@/lib/logger'
import { getRequestId } from '@/lib/request-id'
import { recordMetric } from '@/lib/metrics'
import { logAudit } from '@/lib/audit'

/**
 * Hard safety floor. A company may set retention_days as low as 30 in the UI,
 * but if a row somehow carries a sub-30 value (manual DB edit, future bug, a
 * migration default) we REFUSE to honor it — deleting customer conversations
 * on a < 30-day window is almost certainly a mistake, not intent. Such
 * companies are skipped and logged, never purged.
 */
const MIN_RETENTION_DAYS = 30
/**
 * Per-company per-run cap. We delete at most this many (oldest-first)
 * conversations per company per invocation, so a tenant with a huge backlog
 * drains gradually over successive daily runs rather than issuing one
 * unbounded DELETE. A company that hits the cap is logged so it's visible
 * that more remain.
 */
const PURGE_CAP = 500
const MS_PER_DAY = 24 * 60 * 60 * 1000
/**
 * Conversation statuses that are eligible for retention purge. ONLY terminal
 * states. active / in_progress / waiting_on_customer / escalated are NEVER
 * purged regardless of age — they represent open work.
 */
const PURGEABLE_STATUSES = ['resolved', 'archived'] as const

/**
 * Authorize cron invocation. Accepts either `X-Webhook-Secret` (internal
 * callers) or `Authorization: Bearer <WEBHOOK_SECRET>` (Vercel Cron). Mirrors
 * the helper in notification-digest / sla-check — timing-safe comparison via
 * validateWebhookSecret.
 */
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

/**
 * Daily data-retention purge cron.
 *
 * For every company with a non-null retention_days, permanently deletes the
 * OLDEST resolved/archived conversations whose last activity predates the
 * company's retention window. All FKs referencing conversations are
 * ON DELETE CASCADE (messages, ai_replies, conversation_notes,
 * conversation_time_entries, csat_surveys, note_mentions, ooo_replies_sent,
 * pending_sends, scheduled_messages, conversation_merges) and the self-ref
 * merged_into_id is SET NULL, so deleting the conversation row cleanly removes
 * every dependent — we do NOT pre-delete children.
 *
 * Safety:
 *   - Hard 30-day floor: a sub-30 retention_days is skipped (never honored).
 *   - Only 'resolved' / 'archived' are purgeable; open statuses are immune.
 *   - Per-company cap of 500/run so a backlog drains gradually.
 *   - Per-company try/catch: one tenant's failure can't abort the rest.
 *   - Recency anchor is COALESCE(last_message_at, created_at) — conversations
 *     has no updated_at column.
 *
 * Logic lives in GET because Vercel Cron invokes scheduled paths via GET; the
 * `export const POST = GET` at the bottom keeps manual/internal POST triggers
 * working (both verbs run the same authorized logic).
 *
 * Everything is fail-soft so the cron-health dead-man's-switch stays green:
 * per-company work is isolated, and the whole route is wrapped so a top-level
 * fault returns 500 (the only case that should turn the cron red).
 */
export async function GET(request: Request) {
  const requestId = await getRequestId()
  const startedAt = Date.now()

  if (!authorizeCron(request)) {
    return NextResponse.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 })
  }

  try {
    const supabase = await createServiceRoleClient()

    logInfo('system', 'retention_purge_start', 'retention-purge cron started', {
      request_id: requestId,
    })

    // ── 1. Companies that have retention configured ─────────────────────
    const { data: companyRows, error: companyErr } = await supabase
      .from('companies')
      .select('id, name, retention_days')
      .not('retention_days', 'is', null)

    if (companyErr) {
      logError('system', 'retention_purge_companies_query_error', companyErr.message, {
        request_id: requestId,
      })
      recordMetric('cron.retention_purge.duration_ms', Date.now() - startedAt, { success: false }, requestId)
      recordMetric('cron.retention_purge.errors', 1, { stage: 'query', fatal: true }, requestId)
      return NextResponse.json({ error: companyErr.message, request_id: requestId }, { status: 500 })
    }

    const companies = (companyRows ?? []) as {
      id: string
      name: string | null
      retention_days: number | null
    }[]

    let companiesPurged = 0
    let companiesSkipped = 0
    let totalDeleted = 0

    // ── 2. Per-company purge — isolated so one failure can't abort the run ──
    for (const company of companies) {
      try {
        const retentionDays = company.retention_days
        if (retentionDays == null) continue

        // SAFETY FLOOR — never honor a sub-30-day window.
        if (retentionDays < MIN_RETENTION_DAYS) {
          companiesSkipped++
          logWarn('system', 'retention_floor_skipped', 'retention_days below 30-day floor — skipped', {
            request_id: requestId,
            company_id: company.id,
            retention_days: retentionDays,
          })
          continue
        }

        const cutoffIso = new Date(startedAt - retentionDays * MS_PER_DAY).toISOString()

        // Resolve the company's account ids — conversations are scoped by
        // account_id, and account_id → company is the tenancy join.
        const { data: accountRows, error: acctErr } = await supabase
          .from('accounts')
          .select('id')
          .eq('company_id', company.id)
        if (acctErr) {
          throw new Error(`accounts query failed: ${acctErr.message}`)
        }
        const accountIds = (accountRows ?? []).map((a) => (a as { id: string }).id)
        if (accountIds.length === 0) continue

        // Select the OLDEST purgeable conversations (cap PURGE_CAP). Only
        // resolved/archived. The recency anchor is COALESCE(last_message_at,
        // created_at) < cutoff. PostgREST can't filter on a COALESCE directly,
        // so we express the equivalent as an OR: `last_message_at.lt.cutoff`
        // (which already excludes NULLs, since NULL is never < cutoff) OR
        // (last_message_at IS NULL AND created_at < cutoff). Ordering mirrors
        // the anchor — NULL last_message_at rows first (they fall back to
        // created_at), then by created_at — so we always take the oldest.
        const { data: convRows, error: convErr } = await supabase
          .from('conversations')
          .select('id, last_message_at, created_at')
          .in('account_id', accountIds)
          .in('status', [...PURGEABLE_STATUSES])
          // Never purge a conversation with a pending snooze. A resolved/archived
          // conversation can carry a future snoozed_until that the wake-snoozed
          // cron will reopen; deleting it would silently destroy that scheduled
          // resurfacing. Pending-snooze rows are immune regardless of age.
          .is('snoozed_until', null)
          .or(
            `last_message_at.lt.${cutoffIso},` +
              `and(last_message_at.is.null,created_at.lt.${cutoffIso})`,
          )
          .order('last_message_at', { ascending: true, nullsFirst: true })
          .order('created_at', { ascending: true })
          .limit(PURGE_CAP)
        if (convErr) {
          throw new Error(`conversations query failed: ${convErr.message}`)
        }

        const ids = (convRows ?? []).map((c) => (c as { id: string }).id)
        if (ids.length === 0) continue

        // DELETE by id. Cascade FKs remove all dependents in one round-trip.
        const { error: delErr } = await supabase
          .from('conversations')
          .delete()
          .in('id', ids)
        if (delErr) {
          throw new Error(`delete failed: ${delErr.message}`)
        }

        const deleted = ids.length
        totalDeleted += deleted
        companiesPurged++

        const capped = deleted === PURGE_CAP
        if (capped) {
          logInfo('system', 'retention_purge_capped', 'company hit per-run purge cap — more remain', {
            request_id: requestId,
            company_id: company.id,
            deleted,
            cap: PURGE_CAP,
          })
        }

        logInfo('system', 'retention_purge_company', 'purged conversations for company', {
          request_id: requestId,
          company_id: company.id,
          deleted,
          cutoff: cutoffIso,
          retention_days: retentionDays,
          capped,
        })

        // One audit row per company actually purged.
        await logAudit({
          company_id: company.id,
          action: 'data_retention_purge',
          entity_type: 'company',
          entity_id: company.id,
          details: {
            company_id: company.id,
            count: deleted,
            cutoff: cutoffIso,
            retention_days: retentionDays,
            capped,
          },
        })
      } catch (companyErrInner) {
        // FAIL-SOFT per company: log + continue with the next tenant.
        logError(
          'system',
          'retention_purge_company_error',
          companyErrInner instanceof Error ? companyErrInner.message : String(companyErrInner),
          { request_id: requestId, company_id: company.id }
        )
        recordMetric('cron.retention_purge.errors', 1, { stage: 'company' }, requestId)
      }
    }

    const durationMs = Date.now() - startedAt
    logInfo('system', 'retention_purge_end', 'retention-purge cron finished', {
      request_id: requestId,
      companies_configured: companies.length,
      companies_purged: companiesPurged,
      companies_skipped: companiesSkipped,
      total_deleted: totalDeleted,
      duration_ms: durationMs,
    })
    recordMetric('cron.retention_purge.duration_ms', durationMs, { success: true }, requestId)
    recordMetric('cron.retention_purge.deleted', totalDeleted, undefined, requestId)

    return NextResponse.json({
      companies_configured: companies.length,
      companies_purged: companiesPurged,
      companies_skipped: companiesSkipped,
      total_deleted: totalDeleted,
      request_id: requestId,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('retention-purge error:', message)
    recordMetric('cron.retention_purge.duration_ms', Date.now() - startedAt, { success: false }, requestId)
    recordMetric('cron.retention_purge.errors', 1, { fatal: true }, requestId)
    return NextResponse.json({ error: message, request_id: requestId }, { status: 500 })
  }
}

// Vercel Cron invokes scheduled paths via GET; keep POST working for internal
// callers and manual triggers (both verbs run the same authorized logic).
export const POST = GET
