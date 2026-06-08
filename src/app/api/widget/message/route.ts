// POST /api/widget/message  { key, session_id, text, visitor_name? }
// Public — a website visitor sends a chat message. Lands in the inbox as a
// `livechat` conversation (grouped by session_id in teams_chat_id). Authed by
// the public widget_key; rate-limited per session.
import { NextResponse, after } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { checkRateLimit, findOrCreateConversation, getAccountSettings } from '@/lib/api-helpers'
import { resolveWidget, WIDGET_CORS } from '@/lib/livechat'

const MAX_TEXT = 4000

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: WIDGET_CORS })
}

export async function POST(request: Request) {
  let body: { key?: string; session_id?: string; text?: string; visitor_name?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: WIDGET_CORS })
  }

  const key = (body.key || '').trim()
  const sessionId = (body.session_id || '').trim()
  const text = (body.text || '').trim()
  if (!key || !sessionId || !text) {
    return NextResponse.json({ error: 'key, session_id and text are required' }, { status: 400, headers: WIDGET_CORS })
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json({ error: 'Message too long' }, { status: 400, headers: WIDGET_CORS })
  }

  const supabase = await createServiceRoleClient()
  const widget = await resolveWidget(supabase, key)
  if (!widget) {
    return NextResponse.json({ error: 'Widget not found' }, { status: 404, headers: WIDGET_CORS })
  }
  const accountId = widget.account_id

  // Rate limit per (widget, session) to curb spam from a single visitor.
  if (!(await checkRateLimit(`widget_${key}_${sessionId}`, 30, 60))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers: WIDGET_CORS })
  }

  const visitorName = (body.visitor_name || 'Website visitor').toString().slice(0, 80)

  const conversationId = await findOrCreateConversation(supabase, {
    account_id: accountId,
    channel: 'livechat',
    teams_chat_id: sessionId,
    participant_name: visitorName,
  })

  const { data: message, error: msgError } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      account_id: accountId,
      channel: 'livechat',
      teams_chat_id: sessionId,
      sender_name: visitorName,
      sender_type: 'customer',
      message_text: text,
      message_type: 'text',
      direction: 'inbound',
      replied: false,
      reply_required: true,
      timestamp: new Date().toISOString(),
      received_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (msgError || !message) {
    return NextResponse.json({ error: 'Failed to store message' }, { status: 500, headers: WIDGET_CORS })
  }

  // Notify agents about the new chat (async, non-blocking).
  try {
    const { triggerNotifications } = await import('@/lib/notification-service')
    triggerNotifications(supabase, {
      id: message.id,
      conversation_id: conversationId,
      account_id: accountId,
      account_name: 'Live Chat',
      channel: 'livechat',
      sender_name: visitorName,
      email_subject: null,
      message_text: text.substring(0, 200),
      is_spam: false,
    }).catch(() => undefined)
  } catch { /* non-fatal */ }

  // AI dispatch — fire-and-forget via after() so the widget gets a fast response.
  const account = await getAccountSettings(supabase, accountId)
  const origin = new URL(request.url).origin
  const headers = { 'Content-Type': 'application/json', 'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '' }
  if (account.phase1_enabled) {
    after(() =>
      fetch(`${origin}/api/classify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message_id: message.id, message_text: text, channel: 'livechat', account_id: accountId }),
      }).then(() => undefined, () => undefined)
    )
  }
  if (account.phase2_enabled) {
    after(() =>
      fetch(`${origin}/api/ai-reply`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message_id: message.id, message_text: text, channel: 'livechat', account_id: accountId, conversation_id: conversationId }),
      }).then(() => undefined, () => undefined)
    )
  }

  return NextResponse.json({ ok: true, message_id: message.id }, { status: 201, headers: WIDGET_CORS })
}
