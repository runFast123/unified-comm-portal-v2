/**
 * POST /api/v1/conversations/[id]/messages
 *
 * Token-authed reply endpoint. Sends an outbound message on the conversation's
 * channel via the same `sendEmail` / `sendTeams` / `sendWhatsApp` pipeline
 * the dashboard uses — same provider configs, same audit, same realtime
 * notifications.
 *
 * Body: { body: string, subject?: string }
 *
 * Required scope: `messages:write`
 *
 * Implementation notes:
 *   - We deliberately do NOT call /api/send (that route requires a session
 *     cookie and a user.id for audit). Instead we duplicate just the slim
 *     dispatch path here, recording the outbound message with sender_type
 *     'agent' and the token's name in `sender_name`.
 *   - The conversation must belong to a company-scoped account that matches
 *     `tokenInfo.company_id`. Cross-company access returns 404 to avoid a
 *     resource-existence oracle.
 */

import { NextResponse } from 'next/server'

import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireToken } from '@/app/api/v1/_helpers'
import { sendEmail, sendTeams, sendWhatsApp } from '@/lib/channel-sender'
import { logError, logInfo } from '@/lib/logger'

interface PostBody {
  body?: unknown
  subject?: unknown
}

const MAX_BODY_LEN = 50_000
const MAX_SUBJECT_LEN = 500

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Missing conversation id' }, { status: 400 })

  const gate = await requireToken(request, 'messages:write')
  if (!gate.ok) return gate.response

  let payload: PostBody
  try {
    payload = (await request.json()) as PostBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const messageBody = typeof payload.body === 'string' ? payload.body : ''
  if (!messageBody.trim()) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 })
  }
  if (messageBody.length > MAX_BODY_LEN) {
    return NextResponse.json({ error: `body too long (max ${MAX_BODY_LEN} chars)` }, { status: 400 })
  }

  let subject: string | null = null
  if (payload.subject != null) {
    if (typeof payload.subject !== 'string') {
      return NextResponse.json({ error: 'subject must be a string' }, { status: 400 })
    }
    subject = payload.subject.trim().slice(0, MAX_SUBJECT_LEN) || null
  }

  const admin = await createServiceRoleClient()

  // Conversation + parent account scope check.
  const { data: conv } = await admin
    .from('conversations')
    .select(
      'id, account_id, channel, participant_email, participant_phone, teams_chat_id, accounts:accounts!inner(id, company_id, is_active)',
    )
    .eq('id', id)
    .maybeSingle<{
      id: string
      account_id: string
      channel: 'email' | 'teams' | 'whatsapp'
      participant_email: string | null
      participant_phone: string | null
      teams_chat_id: string | null
      accounts: { id: string; company_id: string | null; is_active: boolean }
    }>()
  if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

  if (conv.accounts?.company_id !== gate.token.company_id) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }
  if (!conv.accounts.is_active) {
    return NextResponse.json({ error: 'Account is inactive' }, { status: 403 })
  }

  // Look up the token's display name so the outbound message has a useful
  // sender_name in the inbox UI ("API: Acme Zapier integration").
  const { data: tokenRow } = await admin
    .from('api_tokens')
    .select('name')
    .eq('id', gate.token.token_id)
    .maybeSingle()
  const senderLabel = tokenRow?.name ? `API: ${tokenRow.name}` : 'API'

  // Channel dispatch. Same shape as /api/send minus the user-session bits.
  let result: { ok: true; provider_message_id?: string } | { ok: false; error: string }
  if (conv.channel === 'email') {
    if (!conv.participant_email) {
      return NextResponse.json({ error: 'Conversation has no participant email' }, { status: 400 })
    }
    result = await sendEmail({
      accountId: conv.account_id,
      to: conv.participant_email,
      subject: subject || 'Re: Your inquiry',
      body: messageBody,
    })
  } else if (conv.channel === 'teams') {
    if (!conv.teams_chat_id) {
      return NextResponse.json({ error: 'Conversation has no teams_chat_id' }, { status: 400 })
    }
    result = await sendTeams({
      accountId: conv.account_id,
      chatId: conv.teams_chat_id,
      body: messageBody,
    })
  } else if (conv.channel === 'whatsapp') {
    if (!conv.participant_phone) {
      return NextResponse.json({ error: 'Conversation has no participant phone' }, { status: 400 })
    }
    result = await sendWhatsApp({
      accountId: conv.account_id,
      toPhone: conv.participant_phone,
      body: messageBody,
    })
  } else {
    return NextResponse.json({ error: `Unsupported channel: ${conv.channel}` }, { status: 400 })
  }

  if (!result.ok) {
    logError('system', 'v1_send_failed', result.error, {
      conversation_id: id,
      account_id: conv.account_id,
      channel: conv.channel,
      token_id: gate.token.token_id,
    })
    return NextResponse.json({ error: result.error }, { status: 502 })
  }

  // Record the outbound row so the UI / future GETs see the reply.
  const nowIso = new Date().toISOString()
  const { data: stored, error: insertErr } = await admin
    .from('messages')
    .insert({
      conversation_id: id,
      account_id: conv.account_id,
      channel: conv.channel,
      sender_name: senderLabel,
      sender_type: 'agent',
      message_text: messageBody,
      message_type: 'text',
      direction: 'outbound',
      email_subject: conv.channel === 'email' ? subject : null,
      replied: true,
      reply_required: false,
      timestamp: nowIso,
      received_at: nowIso,
    })
    .select('id, received_at')
    .single()
  if (insertErr || !stored) {
    logError('system', 'v1_message_insert_failed', insertErr?.message ?? 'unknown', {
      conversation_id: id,
      account_id: conv.account_id,
    })
    // The send succeeded but we couldn't record it — return 502 so the
    // caller knows something is off. The provider id is in the log.
    return NextResponse.json({ error: 'Send dispatched but message store failed' }, { status: 502 })
  }

  // Mark inbound messages on this conversation as replied.
  await admin
    .from('messages')
    .update({ replied: true })
    .eq('conversation_id', id)
    .eq('direction', 'inbound')
    .eq('replied', false)

  // Audit. The token is the actor; we record token id rather than user.
  try {
    await admin.from('audit_log').insert({
      user_id: null,
      action: 'channel.send',
      entity_type: 'conversation',
      entity_id: id,
      details: {
        channel: conv.channel,
        account_id: conv.account_id,
        provider_message_id: result.provider_message_id ?? null,
        via: 'api_token',
        token_id: gate.token.token_id,
      },
    })
  } catch {
    /* non-fatal */
  }

  logInfo('system', 'v1_send_ok', `Sent ${conv.channel} reply via API token`, {
    conversation_id: id,
    account_id: conv.account_id,
    token_id: gate.token.token_id,
  })

  return NextResponse.json(
    {
      success: true,
      message: stored,
      provider_message_id: result.provider_message_id ?? null,
    },
    { status: 201 },
  )
}
