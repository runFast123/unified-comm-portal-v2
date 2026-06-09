// GET /api/widget/poll?key=<widget_key>&session_id=<id>&after=<iso timestamp>
// Public — the widget polls for new messages in its own session (agent replies +
// its own echoes). Scoped to (the widget's account + this session_id), so a
// visitor can only ever read their own thread.
import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { resolveWidget, WIDGET_CORS } from '@/lib/livechat'

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: WIDGET_CORS })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const key = url.searchParams.get('key')?.trim() ?? ''
  const sessionId = url.searchParams.get('session_id')?.trim() ?? ''
  const after = url.searchParams.get('after')?.trim() || null
  if (!key || !sessionId) {
    return NextResponse.json({ error: 'key and session_id required' }, { status: 400, headers: WIDGET_CORS })
  }

  const supabase = await createServiceRoleClient()
  const widget = await resolveWidget(supabase, key)
  if (!widget) {
    return NextResponse.json({ error: 'Widget not found' }, { status: 404, headers: WIDGET_CORS })
  }

  // The session's conversation (scoped to the widget's account — cross-session
  // reads are impossible because session_id is an unguessable client token).
  const { data: conv } = await supabase
    .from('conversations')
    .select('id, agent_typing_at')
    .eq('account_id', widget.account_id)
    .eq('channel', 'livechat')
    .eq('teams_chat_id', sessionId)
    .maybeSingle()
  if (!conv) {
    return NextResponse.json({ messages: [], agent_typing: false }, { headers: WIDGET_CORS })
  }
  const cv = conv as { id: string; agent_typing_at: string | null }
  const agentTyping = !!cv.agent_typing_at && Date.now() - new Date(cv.agent_typing_at).getTime() < 8000

  let q = supabase
    .from('messages')
    .select('id, direction, message_text, sender_name, timestamp')
    .eq('conversation_id', cv.id)
    .order('timestamp', { ascending: true })
    .limit(200)
  if (after) q = q.gt('timestamp', after)
  const { data: rows } = await q

  const messages = (rows ?? []).map((m) => {
    const r = m as { id: string; direction: string; message_text: string | null; sender_name: string | null; timestamp: string }
    return { id: r.id, direction: r.direction, text: r.message_text ?? '', sender_name: r.sender_name, at: r.timestamp }
  })
  return NextResponse.json({ messages, agent_typing: agentTyping }, { headers: WIDGET_CORS })
}
