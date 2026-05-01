/**
 * GET /api/v1/conversations/[id]
 *
 * Returns a single conversation with its messages. Scope-checked against
 * `conversations:read`. The company scope from the token is verified
 * against the conversation's owning account so callers can't read another
 * tenant's data even with a known UUID.
 *
 * Messages are returned in `received_at ASC` order (oldest first) so a
 * caller can render a thread top-down without re-sorting.
 */

import { NextResponse } from 'next/server'

import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireToken } from '@/app/api/v1/_helpers'

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Missing conversation id' }, { status: 400 })

  const gate = await requireToken(request, 'conversations:read')
  if (!gate.ok) return gate.response

  const admin = await createServiceRoleClient()

  // Conversation + parent account, joined to surface company_id for scope.
  const { data: conv } = await admin
    .from('conversations')
    .select(
      'id, account_id, channel, status, priority, participant_name, participant_email, participant_phone, tags, first_message_at, last_message_at, created_at, accounts:accounts!inner(id, company_id)',
    )
    .eq('id', id)
    .maybeSingle<{
      id: string
      account_id: string
      channel: string
      status: string
      priority: string
      participant_name: string | null
      participant_email: string | null
      participant_phone: string | null
      tags: string[] | null
      first_message_at: string | null
      last_message_at: string | null
      created_at: string
      accounts: { id: string; company_id: string | null }
    }>()
  if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

  if (conv.accounts?.company_id !== gate.token.company_id) {
    // Don't leak existence — a 404 reads the same as a missing row.
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const { data: messages, error: msgErr } = await admin
    .from('messages')
    .select(
      'id, conversation_id, channel, sender_name, sender_type, message_text, message_type, direction, email_subject, attachments, received_at, timestamp',
    )
    .eq('conversation_id', id)
    .order('received_at', { ascending: true })
  if (msgErr) return NextResponse.json({ error: msgErr.message }, { status: 500 })

  // Strip the joined accounts row from the response — callers don't need it.
  const { accounts: _accounts, ...convPublic } = conv
  return NextResponse.json({ conversation: convPublic, messages: messages ?? [] })
}
