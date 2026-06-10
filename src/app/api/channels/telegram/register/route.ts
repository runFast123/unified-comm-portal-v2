// POST /api/channels/telegram/register  { account_id }
// Enables NATIVE Telegram inbound (no relay) for a bot:
//   1. generate a per-account webhook secret
//   2. call Telegram setWebhook → point it at /api/webhooks/telegram?account=<id>
//      with that secret as secret_token
//   3. persist the secret (only AFTER Telegram accepts) so the webhook route can
//      authenticate deliveries via X-Telegram-Bot-Api-Secret-Token
// Auth: authenticated + account access + action:credentials.manage.
import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { verifyAccountAccess } from '@/lib/api-helpers'
import { userIdCan } from '@/lib/permissions/server'
import { getChannelConfig, getMaskedChannelConfig, saveChannelConfig } from '@/lib/channel-config'

export async function POST(request: Request) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { account_id?: string }
  try {
    body = (await request.json()) as { account_id?: string }
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

  // Require the account's OWN saved bot token. getChannelConfig falls back to
  // the platform-wide TELEGRAM_BOT_TOKEN env var, and registering against that
  // shared bot would (a) re-point ALL of its inbound to this one tenant and
  // (b) materialize the platform secret into this tenant's encrypted row.
  const { source } = await getMaskedChannelConfig(accountId, 'telegram')
  if (source !== 'db') {
    return NextResponse.json({ error: 'Save your own bot token first, then enable inbound.' }, { status: 400 })
  }
  const cfg = await getChannelConfig(accountId, 'telegram')
  if (!cfg?.bot_token) {
    return NextResponse.json({ error: 'Save the bot token first, then enable inbound.' }, { status: 400 })
  }

  const secret = crypto.randomBytes(24).toString('hex')
  const origin = new URL(request.url).origin
  const webhookUrl = `${origin}/api/webhooks/telegram?account=${encodeURIComponent(accountId)}`

  // Register with Telegram. drop_pending_updates avoids replaying a backlog.
  let json: { ok?: boolean; description?: string } = {}
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.bot_token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secret,
        allowed_updates: ['message', 'edited_message'],
        drop_pending_updates: true,
      }),
    })
    json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string }
    if (!res.ok || !json.ok) {
      return NextResponse.json({ error: json.description || `Telegram setWebhook failed (${res.status})` }, { status: 502 })
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to reach Telegram' }, { status: 502 })
  }

  // Persist the secret ONLY after Telegram accepted the webhook. The bot token
  // is unchanged (and was just re-validated by setWebhook itself), so keep the
  // Test-Connection status instead of regressing Verified → Not tested.
  await saveChannelConfig(accountId, 'telegram', { ...cfg, webhook_secret: secret }, { preserveTestStatus: true })
  return NextResponse.json({ ok: true, webhook_url: webhookUrl })
}
