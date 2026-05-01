// Auto-send CSAT survey on conversation resolved.
//
// Extracted from the status route so the logic can be unit tested without
// dragging in the full POST handler. Always best-effort — every failure
// path swallows + logs so the caller's status update isn't blocked.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createSurvey, publicSurveyUrl } from '@/lib/csat'
import { sendEmail } from '@/lib/channel-sender'
import { substituteTemplate } from '@/lib/templates'

const DEFAULT_BODY = 'Thanks for working with us! Tap to rate your experience: {{survey_url}}'
const DEFAULT_SUBJECT = 'How did we do?'
const DEDUPE_DAYS = 30

export interface CSATAutoSendResult {
  sent: boolean
  reason?: 'company_disabled' | 'no_email' | 'recently_sent' | 'no_company' | 'send_failed'
  survey_id?: string
  error?: string
}

/**
 * If the company has `csat_enabled=true`, the conversation has a
 * `participant_email`, and no CSAT was sent for this conversation in the
 * last 30 days, mint a survey + send the email. Otherwise no-ops with a
 * `reason` so callers can log the skip.
 */
export async function maybeAutoSendCSAT(
  admin: SupabaseClient,
  conversationId: string,
  accountId: string
): Promise<CSATAutoSendResult> {
  // 1. Resolve company via the conversation's account.
  const { data: account } = await admin
    .from('accounts')
    .select('id, company_id')
    .eq('id', accountId)
    .maybeSingle()
  const companyId = (account as { company_id?: string | null } | null)?.company_id
  if (!companyId) return { sent: false, reason: 'no_company' }

  const { data: company } = await admin
    .from('companies')
    .select('id, name, csat_enabled, csat_email_subject, csat_email_body')
    .eq('id', companyId)
    .maybeSingle()
  const c = company as {
    id: string
    name: string
    csat_enabled: boolean | null
    csat_email_subject: string | null
    csat_email_body: string | null
  } | null
  if (!c?.csat_enabled) return { sent: false, reason: 'company_disabled' }

  // 2. Conversation must have a customer email.
  const { data: conv } = await admin
    .from('conversations')
    .select('id, participant_email, participant_name, assigned_to')
    .eq('id', conversationId)
    .maybeSingle()
  const cv = conv as {
    id: string
    participant_email: string | null
    participant_name: string | null
    assigned_to: string | null
  } | null
  if (!cv?.participant_email) return { sent: false, reason: 'no_email' }

  // 3. Dedupe: skip if a CSAT was sent for this conversation recently.
  const cutoff = new Date(Date.now() - DEDUPE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data: recent } = await admin
    .from('csat_surveys')
    .select('id')
    .eq('conversation_id', conversationId)
    .gte('sent_at', cutoff)
    .limit(1)
  if (recent && recent.length > 0) return { sent: false, reason: 'recently_sent' }

  // 4. Mint survey + send email.
  const created = await createSurvey(admin, {
    conversationId,
    accountId,
    agentUserId: cv.assigned_to ?? null,
    customerEmail: cv.participant_email,
  })

  const subject = c.csat_email_subject || DEFAULT_SUBJECT
  const template = c.csat_email_body || DEFAULT_BODY
  const url = publicSurveyUrl(created.token)
  const rendered = substituteTemplate(template, {
    customer: { name: cv.participant_name, email: cv.participant_email },
    company: { name: c.name },
  }).replace(/\{\{\s*survey_url\s*\}\}/g, url)

  const result = await sendEmail({
    accountId,
    to: cv.participant_email,
    subject,
    body: rendered,
  })
  if (!result.ok) {
    return { sent: false, reason: 'send_failed', survey_id: created.id, error: result.error }
  }
  return { sent: true, survey_id: created.id }
}
