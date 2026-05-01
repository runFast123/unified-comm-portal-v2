/**
 * POST /api/conversations/[id]/csat/send
 *
 * Manually trigger a CSAT survey for a conversation. Used by the
 * conversation page's "Send CSAT" button.
 *
 * Auth: must be authenticated and have access to the conversation's account.
 *
 * Side effects:
 *   1) Inserts a `csat_surveys` row + mints a signed token.
 *   2) Sends an email to the conversation's `participant_email`.
 *
 * Failure modes:
 *   - 404 conversation not found
 *   - 403 account scope mismatch
 *   - 422 conversation has no participant_email (can't email a survey)
 *   - 422 same conversation already has a CSAT in last 30 days
 *   - 500 send/insert error
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { verifyAccountAccess } from '@/lib/api-helpers'
import { createSurvey, publicSurveyUrl } from '@/lib/csat'
import { sendEmail } from '@/lib/channel-sender'
import { substituteTemplate } from '@/lib/templates'

const DEFAULT_BODY = 'Thanks for working with us! Tap to rate your experience: {{survey_url}}'
const DEFAULT_SUBJECT = 'How did we do?'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: conversationId } = await context.params
    if (!conversationId) {
      return NextResponse.json({ error: 'Missing conversation id' }, { status: 400 })
    }

    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const admin = await createServiceRoleClient()
    const { data: conv } = await admin
      .from('conversations')
      .select('id, account_id, participant_email, participant_name, assigned_to')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const allowed = await verifyAccountAccess(user.id, conv.account_id)
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!conv.participant_email) {
      return NextResponse.json(
        { error: 'Conversation has no customer email — CSAT cannot be sent.' },
        { status: 422 }
      )
    }

    // Don't double-send. If we sent a CSAT for this conversation in the
    // last 30 days, skip — manual sends should still be subject to this
    // throttle so an over-eager click doesn't spam the customer.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: recent } = await admin
      .from('csat_surveys')
      .select('id')
      .eq('conversation_id', conversationId)
      .gte('sent_at', cutoff)
      .limit(1)
    if (recent && recent.length > 0) {
      return NextResponse.json(
        { error: 'A CSAT survey was already sent for this conversation in the last 30 days.' },
        { status: 422 }
      )
    }

    // Look up the company for branding + body override.
    const { data: account } = await admin
      .from('accounts')
      .select('id, company_id')
      .eq('id', conv.account_id)
      .maybeSingle()
    let companyName: string | null = null
    let bodyTemplate = DEFAULT_BODY
    let subject = DEFAULT_SUBJECT
    if ((account as { company_id?: string | null } | null)?.company_id) {
      const { data: company } = await admin
        .from('companies')
        .select('name, csat_email_subject, csat_email_body')
        .eq('id', (account as { company_id: string }).company_id)
        .maybeSingle()
      const c = company as {
        name: string
        csat_email_subject: string | null
        csat_email_body: string | null
      } | null
      if (c) {
        companyName = c.name
        if (c.csat_email_subject) subject = c.csat_email_subject
        if (c.csat_email_body) bodyTemplate = c.csat_email_body
      }
    }

    const created = await createSurvey(admin, {
      conversationId,
      accountId: conv.account_id,
      agentUserId: conv.assigned_to ?? null,
      customerEmail: conv.participant_email,
    })

    const url = publicSurveyUrl(created.token)
    const rendered = renderCSATBody(bodyTemplate, {
      url,
      customer: { name: conv.participant_name, email: conv.participant_email },
      company: { name: companyName },
    })

    const sendResult = await sendEmail({
      accountId: conv.account_id,
      to: conv.participant_email,
      subject,
      body: rendered,
    })

    if (!sendResult.ok) {
      // Survey row stays — caller can retry via the button. Surface error.
      return NextResponse.json(
        { error: `Created survey but email failed: ${sendResult.error}`, survey_id: created.id },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      survey_id: created.id,
      public_url: url,
    })
  } catch (err) {
    console.error('CSAT send error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}

interface RenderCtx {
  url: string
  customer?: { name?: string | null; email?: string | null } | null
  company?: { name?: string | null } | null
}

/**
 * Renders the CSAT email body. Substitutes the standard template variables
 * via `substituteTemplate` (re-using the same sanitizer as reply templates),
 * then drops `{{survey_url}}` in last so a poisoned company name can't smuggle
 * a double-substituted URL.
 */
export function renderCSATBody(template: string, ctx: RenderCtx): string {
  const standard = substituteTemplate(template, {
    customer: ctx.customer ?? null,
    company: ctx.company ?? null,
  })
  // Replace EVERY `{{survey_url}}` (any whitespace) with the URL.
  return standard.replace(/\{\{\s*survey_url\s*\}\}/g, ctx.url)
}
