import { NextResponse } from 'next/server'
import nodemailer from 'nodemailer'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { validateWebhookSecret } from '@/lib/api-helpers'
import { logError, logInfo } from '@/lib/logger'
import { getRequestId } from '@/lib/request-id'
import { recordMetric } from '@/lib/metrics'
import { COMPANY_ADMIN_ROLE_NAMES } from '@/lib/roles'

/** Lookback window for "recent" failures / breaches in the digest. */
const WINDOW_MS = 24 * 60 * 60 * 1000
/** Poll-failure count at which an account is considered unhealthy/disconnected. */
const UNHEALTHY_POLL_FAILURES = 3
/** Overall cap on the email fan-out, mirroring sendSystemAlert's Promise.race. */
const DELIVERY_TIMEOUT_MS = 15000

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Authorize cron invocation. Accepts either `X-Webhook-Secret` (internal
 * callers) or `Authorization: Bearer <WEBHOOK_SECRET>` (Vercel Cron). Mirrors
 * the helper in sla-check / dispatch-scheduled — timing-safe comparison via
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

interface CompanyDigest {
  companyId: string
  escalated: number
  failedSends: number
  unhealthyChannels: number
}

/**
 * Daily admin digest cron.
 *
 * Aggregates, per company that has at least one active admin:
 *   (a) conversations currently status='escalated'  — open SLA breaches
 *   (b) failed sends in the last 24h                 — pending_sends +
 *       scheduled_messages with status='failed'
 *   (c) accounts with consecutive_poll_failures >= 3 — unhealthy / disconnected
 *
 * A company with all-zero counts is SKIPPED (never email an empty digest).
 * Otherwise its active admins get one concise email with the counts + a
 * portal link.
 *
 * Logic lives in GET because Vercel Cron invokes scheduled paths via GET; the
 * `export const POST = GET` at the bottom keeps manual/internal POST triggers
 * working. (The sla-check route originally had its logic in POST + a stub GET
 * and so never ran on schedule — deliberately NOT repeated here.)
 *
 * Everything is fail-soft: per-company aggregation/delivery is isolated so one
 * company's failure can't abort the others, and the whole route is wrapped so
 * the cron-health dead-man's-switch stays green.
 */
export async function GET(request: Request) {
  const requestId = await getRequestId()
  const startedAt = Date.now()

  if (!authorizeCron(request)) {
    return NextResponse.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 })
  }

  try {
    const supabase = await createServiceRoleClient()
    const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString()
    const portalUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://unified-comm-portal.vercel.app'

    logInfo('system', 'notification_digest_start', 'notification-digest cron started', {
      request_id: requestId,
    })

    // ── 1. Companies that have at least one active admin ────────────────
    // The digest is admin-facing, so a company with no admins is irrelevant.
    // Resolve the admin email list per company up front (same shape as
    // sendSystemAlert: active company-admin roles).
    const { data: adminRows, error: adminErr } = await supabase
      .from('users')
      .select('company_id, email')
      .in('role', [...COMPANY_ADMIN_ROLE_NAMES])
      .eq('is_active', true)
      .not('company_id', 'is', null)

    if (adminErr) {
      logError('system', 'notification_digest_admins_query_error', adminErr.message, {
        request_id: requestId,
      })
      recordMetric('cron.notification_digest.duration_ms', Date.now() - startedAt, { success: false }, requestId)
      recordMetric('cron.notification_digest.errors', 1, { stage: 'query', fatal: true }, requestId)
      return NextResponse.json({ error: adminErr.message, request_id: requestId }, { status: 500 })
    }

    const adminEmailsByCompany = new Map<string, string[]>()
    for (const r of (adminRows ?? []) as { company_id: string | null; email: string | null }[]) {
      if (!r.company_id) continue
      const email = r.email?.trim().toLowerCase()
      if (!email) continue
      const list = adminEmailsByCompany.get(r.company_id) ?? []
      if (!list.includes(email)) list.push(email)
      adminEmailsByCompany.set(r.company_id, list)
    }

    if (adminEmailsByCompany.size === 0) {
      recordMetric('cron.notification_digest.duration_ms', Date.now() - startedAt, { success: true }, requestId)
      return NextResponse.json({ digested: 0, message: 'No companies with active admins', request_id: requestId })
    }

    const companyIds = [...adminEmailsByCompany.keys()]

    // ── 2. Aggregate the three signals, scoped to those companies ───────
    // accounts.company_id is the tenancy join for (b) failed sends and
    // (c) unhealthy channels (both keyed by account_id), so map account → company.
    const { data: accountRows, error: acctErr } = await supabase
      .from('accounts')
      .select('id, company_id, consecutive_poll_failures')
      .in('company_id', companyIds)

    if (acctErr) {
      logError('system', 'notification_digest_accounts_query_error', acctErr.message, {
        request_id: requestId,
      })
      recordMetric('cron.notification_digest.duration_ms', Date.now() - startedAt, { success: false }, requestId)
      recordMetric('cron.notification_digest.errors', 1, { stage: 'query', fatal: true }, requestId)
      return NextResponse.json({ error: acctErr.message, request_id: requestId }, { status: 500 })
    }

    const accounts = (accountRows ?? []) as {
      id: string
      company_id: string | null
      consecutive_poll_failures: number | null
    }[]
    const companyByAccount = new Map<string, string>()
    const accountIds: string[] = []
    const counts = new Map<string, CompanyDigest>()
    for (const companyId of companyIds) {
      counts.set(companyId, { companyId, escalated: 0, failedSends: 0, unhealthyChannels: 0 })
    }
    for (const a of accounts) {
      if (!a.company_id) continue
      companyByAccount.set(a.id, a.company_id)
      accountIds.push(a.id)
      // (c) unhealthy / disconnected channels — current state.
      if ((a.consecutive_poll_failures ?? 0) >= UNHEALTHY_POLL_FAILURES) {
        const c = counts.get(a.company_id)
        if (c) c.unhealthyChannels++
      }
    }

    // (a) Open SLA breaches: conversations currently escalated. Scope via
    // account_id → company. Pull account_id and tally per company.
    if (accountIds.length > 0) {
      const { data: escalatedRows, error: escErr } = await supabase
        .from('conversations')
        .select('account_id')
        .eq('status', 'escalated')
        .in('account_id', accountIds)
      if (escErr) {
        logError('system', 'notification_digest_escalated_query_error', escErr.message, { request_id: requestId })
      } else {
        for (const row of (escalatedRows ?? []) as { account_id: string | null }[]) {
          const companyId = row.account_id ? companyByAccount.get(row.account_id) : undefined
          const c = companyId ? counts.get(companyId) : undefined
          if (c) c.escalated++
        }
      }

      // (b) Failed sends in the last 24h: pending_sends + scheduled_messages.
      // Neither table stores a dedicated failure timestamp (see the failed-send
      // reader in api/scheduled-messages/route.ts), so we use each table's
      // due-time column as the recency proxy — the dispatcher attempts a row
      // within ~60s of its due time, so it's the closest signal and is
      // confirmed present on both tables. window = last 24h.
      const failedTables: Array<{ table: 'pending_sends' | 'scheduled_messages'; dueCol: string }> = [
        { table: 'pending_sends', dueCol: 'send_at' },
        { table: 'scheduled_messages', dueCol: 'scheduled_for' },
      ]
      for (const { table, dueCol } of failedTables) {
        const { data: failedRows, error: failErr } = await supabase
          .from(table)
          .select('account_id')
          .eq('status', 'failed')
          .gte(dueCol, sinceIso)
          .in('account_id', accountIds)
        if (failErr) {
          // Fail-soft: a missing column / table in some environment must not
          // abort the digest — just skip this signal and log.
          logError('system', 'notification_digest_failed_sends_query_error', failErr.message, {
            request_id: requestId,
            table,
          })
          continue
        }
        for (const row of (failedRows ?? []) as { account_id: string | null }[]) {
          const companyId = row.account_id ? companyByAccount.get(row.account_id) : undefined
          const c = companyId ? counts.get(companyId) : undefined
          if (c) c.failedSends++
        }
      }
    }

    // ── 3. Email the digest, per company, skipping all-zero companies ───
    const smtpUser = process.env.SMTP_USER
    const smtpPassword = process.env.SMTP_PASSWORD
    const smtpReady = !!smtpUser && !!smtpPassword

    // Single transport for the whole run, with the same bounded timeouts as
    // sendSystemAlert so a hung mail server can't stall the cron.
    const transporter = smtpReady
      ? nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: { user: smtpUser as string, pass: smtpPassword as string },
          connectionTimeout: 8000,
          greetingTimeout: 8000,
          socketTimeout: 12000,
        })
      : null

    let companiesWithActivity = 0
    let companiesEmailed = 0
    const deliveries: Promise<unknown>[] = []

    for (const companyId of companyIds) {
      // Per-company try/catch: one company's failure must never abort the rest.
      try {
        const c = counts.get(companyId)
        if (!c) continue
        const total = c.escalated + c.failedSends + c.unhealthyChannels
        // Never email an empty digest.
        if (total === 0) continue
        companiesWithActivity++

        const emails = adminEmailsByCompany.get(companyId) ?? []
        if (emails.length === 0) continue
        if (!transporter) continue

        const lines: string[] = []
        if (c.escalated > 0) lines.push(`${c.escalated} escalated conversation${c.escalated === 1 ? '' : 's'} (open SLA breach${c.escalated === 1 ? '' : 'es'})`)
        if (c.failedSends > 0) lines.push(`${c.failedSends} failed send${c.failedSends === 1 ? '' : 's'} in the last 24h`)
        if (c.unhealthyChannels > 0) lines.push(`${c.unhealthyChannels} channel${c.unhealthyChannels === 1 ? '' : 's'} unhealthy / disconnected`)

        const listHtml = lines.map((l) => `<li style="margin:0 0 6px;">${escapeHtml(l)}</li>`).join('')
        const dashboardUrl = `${portalUrl}/dashboard`
        const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
  <div style="background:#1e293b;padding:16px 24px;"><h1 style="margin:0;color:#fff;font-size:16px;">Unified Comms Portal</h1></div>
  <div style="padding:20px 24px;">
    <h2 style="margin:0 0 16px;font-size:15px;color:#1e293b;">Daily operations digest</h2>
    <p style="margin:0 0 12px;font-size:13px;color:#334155;line-height:1.5;">Items needing attention across your accounts:</p>
    <ul style="margin:0 0 20px;padding-left:20px;font-size:13px;color:#334155;line-height:1.5;">${listHtml}</ul>
    <a href="${dashboardUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:8px 20px;border-radius:6px;font-size:13px;font-weight:500;">Open Portal</a>
  </div>
  <div style="padding:12px 24px;border-top:1px solid #e2e8f0;"><p style="margin:0;font-size:11px;color:#94a3b8;">Unified Communication Portal daily digest</p></div>
</div>`.trim()

        const subject = `[Daily Digest] ${lines.length} item${lines.length === 1 ? '' : 's'} need attention`
        companiesEmailed++
        for (const email of emails) {
          deliveries.push(
            (async () => {
              try {
                await transporter.sendMail({
                  from: `"Unified Comms Portal" <${smtpUser}>`,
                  to: email,
                  subject,
                  html,
                })
              } catch (sendError) {
                console.error(
                  `Failed to send digest to ${email}:`,
                  sendError instanceof Error ? sendError.message : sendError
                )
              }
            })()
          )
        }
      } catch (companyErr) {
        logError(
          'system',
          'notification_digest_company_error',
          companyErr instanceof Error ? companyErr.message : String(companyErr),
          { request_id: requestId, company_id: companyId }
        )
      }
    }

    // Bound the whole fan-out (mirrors sendSystemAlert): even with per-transport
    // SMTP timeouts, await deliveries with an overall cap so a hung server can't
    // stall the cron. Orphaned sends settle on their own.
    await Promise.race([
      Promise.allSettled(deliveries),
      new Promise((resolve) => setTimeout(resolve, DELIVERY_TIMEOUT_MS)),
    ])

    if (companiesWithActivity > 0 && !smtpReady) {
      console.error('SMTP_USER or SMTP_PASSWORD not configured — skipping notification digest emails')
    }

    const durationMs = Date.now() - startedAt
    logInfo('system', 'notification_digest_end', 'notification-digest cron finished', {
      request_id: requestId,
      companies_checked: companyIds.length,
      companies_with_activity: companiesWithActivity,
      companies_emailed: companiesEmailed,
      duration_ms: durationMs,
    })
    recordMetric('cron.notification_digest.duration_ms', durationMs, { success: true }, requestId)
    recordMetric('cron.notification_digest.emailed', companiesEmailed, undefined, requestId)

    return NextResponse.json({
      companies_checked: companyIds.length,
      companies_with_activity: companiesWithActivity,
      companies_emailed: companiesEmailed,
      request_id: requestId,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('notification-digest error:', message)
    recordMetric('cron.notification_digest.duration_ms', Date.now() - startedAt, { success: false }, requestId)
    recordMetric('cron.notification_digest.errors', 1, { fatal: true }, requestId)
    return NextResponse.json({ error: message, request_id: requestId }, { status: 500 })
  }
}

// Vercel Cron invokes scheduled paths via GET; keep POST working for internal
// callers and manual triggers (both verbs run the same authorized logic).
export const POST = GET
