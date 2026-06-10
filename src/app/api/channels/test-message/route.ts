// POST /api/channels/test-message  { account_id, to? }
// Sends a REAL outbound message through the account's channel so the user gets
// end-to-end proof the connection works (Test-Connection only validates creds).
// Deliberately limited to channels where a test-send makes sense without an
// existing conversation:
//   email — self-send to the account's own mailbox (recipient NOT caller-chosen,
//           so the endpoint can't be abused as a relay)
//   sms   — to a caller-supplied E.164 number. Cold-originating to an arbitrary
//           number is a toll-fraud surface, so this is gated on
//           action:credentials.manage (the users who already control the Twilio
//           creds and could send freely with them) and double rate-limited
//           (per-account AND per-user).
// Telegram/Meta channels can't message a user who hasn't messaged first
// (provider policy) — their proof is the inbound path ("Last inbound" chip).
import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { verifyAccountAccess, checkRateLimit } from '@/lib/api-helpers'
import { userIdCan } from '@/lib/permissions/server'
import { sendViaChannel } from '@/lib/channels/adapters'

const E164 = /^\+[1-9]\d{6,14}$/

export async function POST(request: Request) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { account_id?: string; to?: string }
  try {
    body = (await request.json()) as { account_id?: string; to?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const accountId = (body.account_id || '').trim()
  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  if (!(await verifyAccountAccess(user.id, accountId))) {
    return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
  }
  if (!(await userIdCan(user.id, 'action:credentials.manage'))) {
    return NextResponse.json({ error: 'Forbidden: missing permission' }, { status: 403 })
  }
  if (!(await checkRateLimit(`testmsg_${accountId}`, 5, 60))) {
    return NextResponse.json({ error: 'Rate limit exceeded — try again in a minute' }, { status: 429 })
  }
  if (!(await checkRateLimit(`testmsg_user_${user.id}`, 10, 3600))) {
    return NextResponse.json({ error: 'Rate limit exceeded — max 10 test messages per hour' }, { status: 429 })
  }

  const admin = await createServiceRoleClient()
  const { data: account } = await admin
    .from('accounts')
    .select('id, name, channel_type, gmail_address, is_active')
    .eq('id', accountId)
    .single()
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  if (!account.is_active) return NextResponse.json({ error: 'Account is not active' }, { status: 403 })

  const channel = account.channel_type
  let to: string
  if (channel === 'email') {
    // Self-send only: the mailbox emails itself, proving the SMTP round trip.
    to = account.gmail_address || ''
    if (!to) return NextResponse.json({ error: 'This account has no mailbox address set' }, { status: 400 })
  } else if (channel === 'sms') {
    to = (body.to || '').trim()
    if (!E164.test(to)) {
      return NextResponse.json({ error: 'Provide a destination number in E.164 format, e.g. +14155552671' }, { status: 400 })
    }
  } else {
    return NextResponse.json(
      { error: 'Test messages are supported for email and SMS. For Telegram/WhatsApp/Messenger/Instagram, message your bot/page and watch for it in the Inbox.' },
      { status: 400 }
    )
  }

  const result = await sendViaChannel(channel, {
    accountId,
    to,
    subject: channel === 'email' ? 'Test message — channel connected ✓' : null,
    body: `Test message from "${account.name}" — your ${channel} channel on Unified Comm Portal is connected and sending. ✓`,
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error || 'Send failed' }, { status: 502 })
  }
  return NextResponse.json({ ok: true, to })
}
