// POST /api/widget/transcript  { key, session_id }
// Public — emails the visitor a copy of THEIR chat. Sends ONLY to the email stored
// on the conversation (captured at pre-chat), never an address from the request,
// so it can't be used to spam arbitrary people. Hard rate-limited.
import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { resolveWidget, WIDGET_CORS } from '@/lib/livechat'
import { checkRateLimit } from '@/lib/api-helpers'
import { sendEmail } from '@/lib/channel-sender'

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: WIDGET_CORS })
}

export async function POST(request: Request) {
  let body: { key?: string; session_id?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: WIDGET_CORS })
  }
  const key = (body.key || '').trim()
  const sessionId = (body.session_id || '').trim()
  if (!key || !sessionId) {
    return NextResponse.json({ error: 'key and session_id required' }, { status: 400, headers: WIDGET_CORS })
  }

  const admin = await createServiceRoleClient()
  const widget = await resolveWidget(admin, key)
  if (!widget) {
    return NextResponse.json({ error: 'Widget not found' }, { status: 404, headers: WIDGET_CORS })
  }

  // Email is an abuse vector — cap hard (3 per 10 min per session).
  if (!(await checkRateLimit(`widget_tx_${key}_${sessionId}`, 3, 600))) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: WIDGET_CORS })
  }

  // The session's own conversation + the email captured at pre-chat.
  const { data: conv } = await admin
    .from('conversations')
    .select('id, participant_email, participant_name')
    .eq('account_id', widget.account_id)
    .eq('channel', 'livechat')
    .eq('teams_chat_id', sessionId)
    .maybeSingle()
  if (!conv) {
    return NextResponse.json({ error: 'No conversation yet' }, { status: 404, headers: WIDGET_CORS })
  }
  const c = conv as { id: string; participant_email: string | null; participant_name: string | null }
  if (!c.participant_email) {
    // No email on file — the visitor never did the pre-chat form.
    return NextResponse.json({ error: 'no_email' }, { status: 400, headers: WIDGET_CORS })
  }

  const { data: rows } = await admin
    .from('messages')
    .select('direction, message_text, sender_name, timestamp')
    .eq('conversation_id', c.id)
    .order('timestamp', { ascending: true })
    .limit(500)
  const msgs = (rows ?? []) as { direction: string; message_text: string | null; sender_name: string | null; timestamp: string }[]

  // Send FROM the company's email account (its SMTP is known-good); fall back to the
  // livechat account, which resolves to the platform's env SMTP.
  let sendAccountId = widget.account_id
  const { data: lcAcct } = await admin.from('accounts').select('company_id').eq('id', widget.account_id).maybeSingle()
  const companyId = (lcAcct as { company_id: string | null } | null)?.company_id ?? null
  if (companyId) {
    const { data: emailAcct } = await admin
      .from('accounts')
      .select('id')
      .eq('channel_type', 'email')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()
    if (emailAcct) sendAccountId = (emailAcct as { id: string }).id
  }

  // Plain-text transcript (sendEmail escapes + turns newlines into <br/>).
  const lines = msgs
    .map((m) => {
      const who = m.direction === 'inbound' ? c.participant_name || 'You' : m.sender_name || 'Agent'
      const when = m.timestamp ? new Date(m.timestamp).toLocaleString() : ''
      return `${who}${when ? ' (' + when + ')' : ''}:\n${m.message_text || ''}`
    })
    .join('\n\n')
  const title = widget.title || 'Live Chat'
  const text = `Your chat transcript — ${title}\n\n${lines || 'No messages.'}\n\n—\nYou received this because you asked for a copy of your chat.`

  const result = await sendEmail({ accountId: sendAccountId, to: c.participant_email, subject: `Your chat transcript — ${title}`, body: text })
  if (!result.ok) {
    return NextResponse.json({ error: 'send_failed' }, { status: 502, headers: WIDGET_CORS })
  }
  return NextResponse.json({ ok: true }, { headers: WIDGET_CORS })
}
