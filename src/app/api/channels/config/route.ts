import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import {
  getMaskedChannelConfig,
  getChannelConfig,
  saveChannelConfig,
  deleteChannelConfig,
  firstMissingConfigField,
  mergeWithStoredSecrets,
  type Channel,
  type ChannelConfigMap,
} from '@/lib/channel-config'
import { verifyAccountAccess } from '@/lib/api-helpers'
import { userIdCan } from '@/lib/permissions/server'
import { CHANNEL_KEYS } from '@/lib/channels/registry'

const CHANNELS = CHANNEL_KEYS as Channel[]

type AdminCtx = { userId: string }

async function requireAdmin(): Promise<
  | { ok: true; ctx: AdminCtx }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }

  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  if (!['admin','super_admin','company_admin'].includes(profile?.role ?? '')) {
    return { ok: false, status: 403, error: 'Admin only' }
  }
  return { ok: true, ctx: { userId: user.id } }
}

async function writeAudit(userId: string, action: string, accountId: string, channel: Channel) {
  const admin = await createServiceRoleClient()
  await admin.from('audit_log').insert({
    user_id: userId,
    action,
    entity_type: 'channel_config',
    entity_id: null, // channel_configs uses composite lookup, not a stable ID
    details: { account_id: accountId, channel },
  })
}

// GET /api/channels/config?account_id=...&channel=email
// Returns masked credentials + source (db/env/none)
export async function GET(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const url = new URL(request.url)
  const accountId = url.searchParams.get('account_id')
  const channel = url.searchParams.get('channel') as Channel | null
  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })
  if (!channel || !CHANNELS.includes(channel)) {
    return NextResponse.json({ error: `channel must be one of: ${CHANNELS.join(', ')}` }, { status: 400 })
  }

  // Tenant scope: the service-role client below bypasses RLS, so confirm the
  // caller's company owns this account (super_admin passes). Without this a
  // company_admin could read any tenant's masked credentials by account_id.
  if (!(await verifyAccountAccess(gate.ctx.userId, accountId))) {
    return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
  }

  const result = await getMaskedChannelConfig(accountId, channel)
  return NextResponse.json(result)
}

// POST /api/channels/config { account_id, channel, config }
export async function POST(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  try {
    const body = await request.json() as { account_id?: string; channel?: Channel; config?: unknown }
    const { account_id, channel, config } = body
    if (!account_id) return NextResponse.json({ error: 'account_id required' }, { status: 400 })
    if (!channel || !CHANNELS.includes(channel)) {
      return NextResponse.json({ error: `channel must be one of: ${CHANNELS.join(', ')}` }, { status: 400 })
    }
    if (!config || typeof config !== 'object') {
      return NextResponse.json({ error: 'config object required' }, { status: 400 })
    }

    // Tenant scope: block writing credentials to another company's account.
    if (!(await verifyAccountAccess(gate.ctx.userId, account_id))) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }
    if (!(await userIdCan(gate.ctx.userId, 'action:credentials.manage'))) {
      return NextResponse.json({ error: 'Missing permission: action:credentials.manage' }, { status: 403 })
    }

    // Secrets the form left blank — or echoed back as the •••• mask — mean
    // "keep the saved value": merge them from the stored config so rotating
    // one credential doesn't silently wipe another (e.g. the WhatsApp
    // verify_token, which would break Meta's webhook GET re-verification).
    // A non-empty new value still replaces the secret. Runs BEFORE the
    // required-fields check so a kept secret also satisfies validation.
    const c = await mergeWithStoredSecrets(account_id, channel, config as Record<string, unknown>)

    // Minimal shape validation per channel — required fields are declared in the
    // channel-config registry (REQUIRED_CONFIG_FIELDS) so a new channel needs no
    // edit here.
    const missing = firstMissingConfigField(channel, c)
    if (missing) return NextResponse.json({ error: `Missing ${missing}` }, { status: 400 })

    // Telegram: webhook_secret is SERVER-managed proof that setWebhook
    // succeeded for THIS account (only /api/channels/telegram/register writes
    // it, after Telegram accepts). Never accept it from the client — a
    // duplicated account would inherit the source's secret and fake
    // "Inbound on" — and drop it when the bot token changes, because the new
    // bot has no registered webhook.
    if (channel === 'telegram') {
      const existing = await getChannelConfig(account_id, 'telegram')
      delete c.webhook_secret
      if (existing?.webhook_secret && existing.bot_token === c.bot_token) {
        c.webhook_secret = existing.webhook_secret
      }
    }

    await saveChannelConfig(account_id, channel, c as unknown as ChannelConfigMap[typeof channel])

    await writeAudit(gate.ctx.userId, 'channel_config.save', account_id, channel)
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}

// DELETE /api/channels/config?account_id=...&channel=email
export async function DELETE(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const url = new URL(request.url)
  const accountId = url.searchParams.get('account_id')
  const channel = url.searchParams.get('channel') as Channel | null
  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })
  if (!channel || !CHANNELS.includes(channel)) {
    return NextResponse.json({ error: `channel must be one of: ${CHANNELS.join(', ')}` }, { status: 400 })
  }

  // Tenant scope: block deleting another company's channel config.
  if (!(await verifyAccountAccess(gate.ctx.userId, accountId))) {
    return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
  }
  if (!(await userIdCan(gate.ctx.userId, 'action:credentials.manage'))) {
    return NextResponse.json({ error: 'Missing permission: action:credentials.manage' }, { status: 403 })
  }

  await deleteChannelConfig(accountId, channel)
  await writeAudit(gate.ctx.userId, 'channel_config.delete', accountId, channel)
  return NextResponse.json({ success: true })
}
