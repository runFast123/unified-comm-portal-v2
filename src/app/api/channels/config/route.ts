import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import {
  getMaskedChannelConfig,
  saveChannelConfig,
  deleteChannelConfig,
  firstMissingConfigField,
  type Channel,
  type ChannelConfigMap,
} from '@/lib/channel-config'
import { verifyAccountAccess } from '@/lib/api-helpers'
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

    // Minimal shape validation per channel — required fields are declared in the
    // channel-config registry (REQUIRED_CONFIG_FIELDS) so a new channel needs no
    // edit here.
    const c = config as Record<string, unknown>
    const missing = firstMissingConfigField(channel, c)
    if (missing) return NextResponse.json({ error: `Missing ${missing}` }, { status: 400 })
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

  await deleteChannelConfig(accountId, channel)
  await writeAudit(gate.ctx.userId, 'channel_config.delete', accountId, channel)
  return NextResponse.json({ success: true })
}
