// POST /api/conversations/[id]/typing
// An agent signals they're composing a reply on a LIVE-CHAT conversation → the
// visitor's widget shows "Agent is typing…". Lightweight (sets a timestamp the
// widget poll reads). Authenticated + account-scoped (same company).
import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { verifyAccountAccess } from '@/lib/api-helpers'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = await createServiceRoleClient()
  const { data: conv } = await admin
    .from('conversations')
    .select('account_id, channel')
    .eq('id', id)
    .maybeSingle()
  if (!conv) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const c = conv as { account_id: string; channel: string }

  if (!(await verifyAccountAccess(user.id, c.account_id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Only live-chat surfaces a typing indicator to a visitor; no-op for others.
  if (c.channel === 'livechat') {
    await admin.from('conversations').update({ agent_typing_at: new Date().toISOString() }).eq('id', id)
  }
  return NextResponse.json({ ok: true })
}
