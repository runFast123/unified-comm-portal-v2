/**
 * Telling an agent their queued reply never made it out.
 *
 * A failed outbound send leaves no timeline row — from the agent's side the
 * reply simply isn't there — so the failure is invisible unless we say
 * something. Two channels, both best-effort:
 *   1. email to whoever queued it (they may not have the portal open)
 *   2. a bell notification (durable, survives a missed email)
 *
 * Extracted from the dispatch-scheduled cron so the claim reaper
 * (src/lib/dispatch-reaper.ts) announces a give-up the same way the dispatcher
 * announces a send failure — the agent shouldn't be able to tell which code
 * path retired their reply.
 *
 * FAIL-SOFT BY DESIGN: every error is logged and swallowed. A broken SMTP
 * config must never break the dispatch loop or the GC loop.
 */

import nodemailer from 'nodemailer'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logError } from './logger'
import { createNotification } from './notifications'

export type DispatchFailureKind = 'scheduled' | 'pending_send'

export interface DispatchFailureNotice {
  /** Agent who queued the reply. Null (e.g. an unattributed row) => no-op. */
  createdBy: string | null
  conversationId: string
  channel: string
  toAddress: string | null
  error: string
  kind: DispatchFailureKind
  requestId: string
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** How the recipient is described to the agent when we have no address. */
function recipientLabelFor(notice: DispatchFailureNotice): string {
  return notice.toAddress || `the ${notice.channel} recipient`
}

/**
 * Email the agent whose queued reply just failed to dispatch.
 *
 * Fires on the state TRANSITION only — the claim CAS guarantees each row goes
 * into 'failed' at most once per queue attempt (a user-initiated retry resets
 * it to 'pending', making a second failure a new transition) — so this can't
 * spam on every cron run.
 */
async function emailSender(
  admin: SupabaseClient,
  notice: DispatchFailureNotice
): Promise<void> {
  try {
    if (!notice.createdBy) return
    const smtpUser = process.env.SMTP_USER
    const smtpPassword = process.env.SMTP_PASSWORD
    if (!smtpUser || !smtpPassword) return

    const { data: sender } = await admin
      .from('users')
      .select('email')
      .eq('id', notice.createdBy)
      .maybeSingle()
    const senderEmail = (sender as { email: string | null } | null)?.email
    if (!senderEmail) return

    const portalUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://unified-comm-portal.vercel.app'
    const conversationUrl = `${portalUrl}/conversations/${notice.conversationId}`
    const recipientLabel = recipientLabelFor(notice)

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: smtpUser, pass: smtpPassword },
    })
    await transporter.sendMail({
      from: `"Unified Comms Portal" <${smtpUser}>`,
      to: senderEmail,
      subject: `Your reply to ${recipientLabel} failed to send`,
      html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
  <div style="background:#1e293b;padding:16px 24px;"><h1 style="margin:0;color:#fff;font-size:16px;">Unified Comms Portal</h1></div>
  <div style="padding:20px 24px;">
    <h2 style="margin:0 0 12px;font-size:15px;color:#dc2626;">Your reply to ${escapeHtml(recipientLabel)} failed to send</h2>
    <p style="margin:0 0 16px;font-size:13px;color:#334155;line-height:1.5;">The customer did not receive it. Open the conversation to retry.</p>
    <div style="background:#fef2f2;border-left:3px solid #dc2626;padding:10px 14px;margin:0 0 20px;border-radius:0 4px 4px 0;">
      <p style="margin:0 0 4px;font-size:11px;color:#64748b;text-transform:uppercase;">Error</p>
      <p style="margin:0;font-size:13px;color:#334155;line-height:1.5;">${escapeHtml(notice.error.slice(0, 300))}</p>
    </div>
    <a href="${conversationUrl}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:8px 20px;border-radius:6px;font-size:13px;font-weight:500;">Open Conversation</a>
  </div>
  <div style="padding:12px 24px;border-top:1px solid #e2e8f0;"><p style="margin:0;font-size:11px;color:#94a3b8;">Unified Communication Portal notification</p></div>
</div>`.trim(),
    })
  } catch (err) {
    await logError(
      'system',
      'dispatch_failure_notify_failed',
      err instanceof Error ? err.message : String(err),
      {
        request_id: notice.requestId,
        conversation_id: notice.conversationId,
        kind: notice.kind,
        channel: notice.channel,
      }
    )
  }
}

/**
 * Announce a failed outbound send to the agent who queued it: email + bell.
 *
 * Fire-and-forget — callers `void` this so it never blocks a dispatch loop.
 * `admin` must be a service-role client (it reads another user's email and
 * writes a notification on their behalf).
 */
export function notifyDispatchFailure(
  admin: SupabaseClient,
  notice: DispatchFailureNotice
): void {
  void emailSender(admin, notice)

  // createNotification is fail-soft and no-ops on a null user_id, so an
  // unattributed queued row simply gets no bell entry.
  if (!notice.createdBy) return
  void createNotification(
    {
      user_id: notice.createdBy,
      type: 'system_alert',
      title: 'Your reply failed to send',
      body: `To ${recipientLabelFor(notice)}: ${notice.error.slice(0, 200)}`,
      link: `/conversations/${notice.conversationId}`,
      conversation_id: notice.conversationId,
    },
    admin
  )
}
