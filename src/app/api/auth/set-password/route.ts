// POST /api/auth/set-password
//
// PUBLIC endpoint — the single-use setup token IS the authentication (like the
// CSAT token route). Validates a custom password-setup token (minted by
// /api/users/reset-link, stored only as a SHA-256 hash), sets the user's
// password via the GoTrue admin API, confirms their email, and spends the
// token. Because the token is consumed HERE (on POST), a link preview / email
// scanner / browser prefetch (which only does a GET on /accept-invite) can't
// burn it — the core fix for "the reset link is already expired".
//
// Body: { token, password }

import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { checkRateLimit } from '@/lib/rate-limiter'

function clientIp(request: Request): string {
  const h = request.headers
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    h.get('x-real-ip')?.trim() ||
    'unknown'
  )
}

export async function POST(request: Request) {
  let body: { token?: string; password?: string }
  try {
    body = (await request.json()) as { token?: string; password?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const token = typeof body.token === 'string' ? body.token.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!token) return NextResponse.json({ error: 'token is required' }, { status: 400 })
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
  }

  // Throttle brute force against the token + the IP. Fails open.
  const ip = clientIp(request)
  const ipCheck = await checkRateLimit(`set-password:ip:${ip}`, 20, 300)
  const tokenCheck = await checkRateLimit(`set-password:tok:${token.slice(0, 16)}`, 8, 300)
  if (!ipCheck.allowed || !tokenCheck.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a few minutes and try again.' },
      { status: 429 }
    )
  }

  const admin = await createServiceRoleClient()
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

  const { data: row, error: lookErr } = await admin
    .from('password_setup_tokens')
    .select('id, user_id, expires_at, used_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  if (lookErr) {
    return NextResponse.json({ error: 'Server error. Please try again.' }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: 'This link is invalid.' }, { status: 400 })
  }
  if ((row as { used_at?: string | null }).used_at) {
    return NextResponse.json({ error: 'This link has already been used.' }, { status: 400 })
  }
  if (new Date((row as { expires_at: string }).expires_at).getTime() < Date.now()) {
    return NextResponse.json(
      { error: 'This link has expired. Ask your admin for a new one.' },
      { status: 400 }
    )
  }

  const userId = (row as { user_id: string }).user_id
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: 'Server is misconfigured.' }, { status: 500 })
  }

  // Set the password + confirm the email via the GoTrue admin API.
  let ok = false
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password, email_confirm: true }),
    })
    ok = r.ok
  } catch {
    ok = false
  }
  if (!ok) {
    return NextResponse.json({ error: 'Could not set the password. Please try again.' }, { status: 502 })
  }

  // Spend this token + invalidate any other outstanding tokens for the user.
  await admin
    .from('password_setup_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('used_at', null)

  await admin.from('audit_log').insert({
    user_id: userId,
    action: 'user.set_password',
    entity_type: 'user',
    entity_id: userId,
    details: { via: 'setup_token' },
  })

  return NextResponse.json({ success: true })
}
