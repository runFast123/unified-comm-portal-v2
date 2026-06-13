import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { validateWebhookSecret } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { isWithinBusinessHours, businessMillisElapsed } from '@/lib/business-hours'
import { getRequestId } from '@/lib/request-id'
import { recordMetric } from '@/lib/metrics'
import { sendSystemAlert } from '@/lib/notification-service'

/**
 * Accept either `X-Webhook-Secret` (internal callers) or
 * `Authorization: Bearer <secret>` (Vercel Cron). Delegates to the shared
 * timing-safe validator in api-helpers.ts. Mirrors the pattern in
 * `src/app/api/cron/email-poll/route.ts`.
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
 * SLA Auto-Escalation Endpoint
 *
 * Can be called periodically via cron.
 * Checks all pending inbound messages older than their account's sla_critical_hours,
 * and escalates the conversation if sla_auto_escalate is enabled.
 *
 * Authentication: requires WEBHOOK_SECRET header (or Bearer for Vercel Cron)
 * or valid user session.
 *
 * Logic lives in GET because Vercel Cron invokes scheduled paths via GET
 * (every other cron route follows the same `export const POST = GET` pattern).
 * It previously lived in POST with a no-op GET stub, so the scheduled run did
 * nothing — fixed here.
 */
export async function GET(request: Request) {
  const requestId = await getRequestId()
  const startedAt = Date.now()
  try {
    // Authenticate via webhook secret (for cron calls) — accepts both
    // X-Webhook-Secret and Authorization: Bearer (Vercel Cron).
    if (!authorizeCron(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = await createServiceRoleClient()

    // 1. Get all accounts with SLA settings (+ company_id for business hours)
    const { data: accounts, error: accountsError } = await supabase
      .from('accounts')
      .select('id, sla_critical_hours, sla_auto_escalate, company_id')
      .eq('is_active', true)

    if (accountsError) {
      // The SLA columns (sla_critical_hours / sla_auto_escalate) are not
      // provisioned in every environment. Treat a missing-column error as
      // "feature not enabled" — a HEALTHY no-op run, not a failure — so the
      // cron-health dead-man's-switch stays green instead of crying wolf.
      const code = (accountsError as { code?: string }).code
      const missingColumn = code === '42703' || /column .* does not exist/i.test(accountsError.message || '')
      if (missingColumn) {
        recordMetric('cron.sla_check.duration_ms', Date.now() - startedAt, { success: true, sla_unconfigured: true }, requestId)
        return NextResponse.json({ escalated: 0, message: 'SLA escalation not configured for this environment', request_id: requestId })
      }
      console.error('SLA check: failed to fetch accounts', accountsError)
      recordMetric('cron.sla_check.duration_ms', Date.now() - startedAt, { success: false }, requestId)
      recordMetric('cron.sla_check.errors', 1, { stage: 'query', fatal: true }, requestId)
      return NextResponse.json({ error: 'Failed to fetch accounts' }, { status: 500 })
    }

    if (!accounts || accounts.length === 0) {
      return NextResponse.json({ escalated: 0, message: 'No active accounts' })
    }

    // 1b. Preload each company's business_hours in ONE query (avoid N+1).
    // null/absent = 24/7 (preserves legacy wall-clock behavior).
    const companyIds = [
      ...new Set(
        accounts
          .map((a: { company_id: string | null }) => a.company_id)
          .filter((id): id is string => !!id)
      ),
    ]
    const businessHoursByCompany = new Map<string, unknown>()
    if (companyIds.length > 0) {
      const { data: companies, error: companiesError } = await supabase
        .from('companies')
        .select('id, business_hours')
        .in('id', companyIds)
      if (companiesError) {
        console.error('SLA check: failed to fetch company business hours', companiesError)
      } else {
        for (const c of companies ?? []) {
          businessHoursByCompany.set(
            (c as { id: string }).id,
            (c as { business_hours: unknown }).business_hours ?? null
          )
        }
      }
    }

    const now = new Date()

    let totalEscalated = 0
    const escalationDetails: { account_id: string; conversation_ids: string[] }[] = []
    // System-alert deliveries collected across accounts, awaited before the
    // response so serverless teardown can't cut them off. sendSystemAlert
    // never throws, so this can't fail the run.
    const alertPromises: Promise<void>[] = []

    for (const account of accounts) {
      // Skip if auto-escalate is disabled
      if (!account.sla_auto_escalate) continue

      const criticalHours = account.sla_critical_hours ?? 4
      const businessHours = account.company_id
        ? businessHoursByCompany.get(account.company_id) ?? null
        : null

      // Business-hours gate: when business hours ARE configured, don't newly
      // escalate while the desk is currently closed — wait until it reopens.
      // With no config, isWithinBusinessHours() returns true (24/7), a no-op.
      if (!isWithinBusinessHours(businessHours, now)) continue

      // Wall-clock pre-filter (cheap, index-backed): a message can only be in
      // BUSINESS-time breach if it's at least this old in real time.
      const cutoff = new Date(now.getTime() - criticalHours * 60 * 60 * 1000).toISOString()

      // 2. Find pending inbound messages older than sla_critical_hours.
      const { data: breachedMessages, error: msgError } = await supabase
        .from('messages')
        .select('conversation_id, received_at')
        .eq('account_id', account.id)
        .eq('direction', 'inbound')
        .eq('reply_required', true)
        .eq('replied', false)
        .lt('received_at', cutoff)

      if (msgError) {
        console.error(`SLA check: failed to query messages for account ${account.id}`, msgError)
        continue
      }

      if (!breachedMessages || breachedMessages.length === 0) continue

      // Keep only conversations whose OLDEST breaching message has accrued more
      // than sla_critical_hours of BUSINESS time. With no config this reduces to
      // exactly the legacy wall-clock condition.
      const criticalMs = criticalHours * 60 * 60 * 1000
      const oldestByConversation = new Map<string, number>()
      for (const m of breachedMessages as { conversation_id: string; received_at: string }[]) {
        const ts = new Date(m.received_at).getTime()
        const prev = oldestByConversation.get(m.conversation_id)
        if (prev === undefined || ts < prev) oldestByConversation.set(m.conversation_id, ts)
      }

      const conversationIds = [...oldestByConversation.entries()]
        .filter(([, oldestTs]) => businessMillisElapsed(businessHours, new Date(oldestTs), now) >= criticalMs)
        .map(([conversationId]) => conversationId)

      if (conversationIds.length === 0) continue

      // 3. Escalate — excluding already escalated/resolved/archived AND anything
      // parked as waiting-on-customer (the conversations.status enum value).
      const { data: updated, error: updateError } = await supabase
        .from('conversations')
        .update({ status: 'escalated' })
        .in('id', conversationIds)
        // PostgREST `in` filter: parenthesized, comma-separated, no spaces
        .not('status', 'in', '(escalated,resolved,archived,waiting_on_customer)')
        .select('id, account_id, participant_name, channel, assigned_to')

      if (updateError) {
        console.error(`SLA check: failed to escalate conversations for account ${account.id}`, updateError)
        continue
      }

      const escalatedCount = updated?.length ?? 0
      if (escalatedCount > 0) {
        totalEscalated += escalatedCount
        const escalatedRows = updated as {
          id: string
          account_id: string
          participant_name: string | null
          channel: string | null
          assigned_to: string | null
        }[]
        escalationDetails.push({
          account_id: account.id,
          conversation_ids: escalatedRows.map((c) => c.id),
        })

        // 4. Audit each escalation (per-entity event). Fire-and-forget;
        // company_id explicit because the cron runs as service-role.
        for (const c of escalatedRows) {
          void logAudit({
            user_id: null,
            company_id: account.company_id ?? null,
            action: 'conversation_escalated',
            entity_type: 'conversation',
            entity_id: c.id,
            details: {
              reason: 'sla_auto_escalation',
              account_id: c.account_id,
              channel: c.channel,
              participant_name: c.participant_name,
              sla_critical_hours: criticalHours,
              business_hours_aware: businessHours != null,
              escalated_at: now.toISOString(),
            },
          })
        }

        // 5. ONE digest system-alert per account per run — never one-per-
        // conversation (a backlog flipping 50 conversations must not email each
        // admin 50×, and would re-open 50 SMTP sockets). These rows are exactly
        // this run's not-escalated → escalated transitions (already-escalated
        // rows are excluded by the status filter), so re-runs won't re-alert.
        const names = escalatedRows.map((c) => c.participant_name || 'Unknown').slice(0, 5).join(', ')
        const more = escalatedCount > 5 ? `, +${escalatedCount - 5} more` : ''
        alertPromises.push(
          sendSystemAlert(supabase, {
            account_id: account.id,
            company_id: account.company_id ?? null,
            type: 'sla_breach',
            title: `SLA breach: ${escalatedCount} conversation${escalatedCount === 1 ? '' : 's'} auto-escalated`,
            body: `${escalatedCount} conversation${escalatedCount === 1 ? '' : 's'} had no reply within ${criticalHours}h and ${escalatedCount === 1 ? 'was' : 'were'} auto-escalated: ${names}${more}.`,
            link: escalatedCount === 1 ? `/conversations/${escalatedRows[0].id}` : `/inbox?status=escalated`,
          })
        )
      }
    }

    await Promise.allSettled(alertPromises)

    // ── Operational metrics — mirrors the other cron routes. `success`
    // label distinguishes these rows from the error catch's emit below.
    const durationMs = Date.now() - startedAt
    recordMetric('cron.sla_check.duration_ms', durationMs, { success: true }, requestId)
    recordMetric('cron.sla_check.escalated', totalEscalated, undefined, requestId)

    return NextResponse.json({
      escalated: totalEscalated,
      details: escalationDetails,
      checked_at: new Date().toISOString(),
      request_id: requestId,
    })
  } catch (err: any) {
    console.error('SLA check error:', err)
    recordMetric('cron.sla_check.duration_ms', Date.now() - startedAt, { success: false }, requestId)
    recordMetric('cron.sla_check.errors', 1, { fatal: true }, requestId)
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 }
    )
  }
}

// Vercel Cron invokes scheduled paths via GET; keep POST working for internal
// callers and manual triggers (both verbs run the same authorized logic).
export const POST = GET
