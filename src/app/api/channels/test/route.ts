import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getAdapter } from '@/lib/channels/adapters'
import { isChannel, CHANNEL_KEYS } from '@/lib/channels/registry'
import { checkRateLimit, verifyAccountAccess } from '@/lib/api-helpers'
import {
  getChannelConfig,
  recordChannelConfigTest,
  type Channel,
  type EmailConfig,
  type TeamsConfig,
  type WhatsAppConfig,
} from '@/lib/channel-config'

type TestBody =
  | { channel: 'email'; config?: EmailConfig; account_id?: string }
  | { channel: 'teams'; config?: TeamsConfig; account_id?: string }
  | { channel: 'whatsapp'; config?: WhatsAppConfig; account_id?: string }

// POST /api/channels/test
//   If `config` is provided, tests those credentials without saving.
//   Otherwise falls back to saved/env creds for account_id.
export async function POST(request: Request) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin.from('users').select('role').eq('id', user.id).maybeSingle()
  if (!['admin','super_admin','company_admin'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  // Test calls hit real SMTP/Graph/WhatsApp endpoints — keep them tight.
  if (!(await checkRateLimit(`test-connection:${user.id}`, 10, 60))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  try {
    const body = (await request.json()) as Partial<TestBody> & { channel?: Channel }
    const { channel, account_id } = body
    if (!isChannel(channel)) {
      return NextResponse.json({ error: `channel must be one of: ${CHANNEL_KEYS.join(', ')}` }, { status: 400 })
    }

    // Tenant scope: when falling back to an account's SAVED credentials, ensure
    // the caller's company owns it — otherwise this becomes a cross-tenant
    // credential-validity oracle (and triggers live auth with their secrets).
    if (account_id && !(await verifyAccountAccess(user.id, account_id))) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }

    // Resolve credentials (caller-provided config, else the account's saved/env
    // creds) and verify them via the channel adapter — one dispatch for all
    // channels instead of a per-channel case.
    const adapter = getAdapter(channel)
    if (!adapter) return NextResponse.json({ error: 'Unsupported channel' }, { status: 400 })
    const cfg = body.config ?? (await getChannelConfig(account_id ?? null, channel))
    if (!cfg) return NextResponse.json({ ok: false, error: 'No credentials configured' })
    const result = await adapter.verifyConfig(cfg)
    // When testing an account's SAVED credentials (not an ad-hoc form test),
    // persist the result so the admin UI can show a verified / failed gate.
    if (!body.config && account_id) {
      await recordChannelConfigTest(account_id, channel, result.ok, result.ok ? null : result.error)
    }
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Test failed' },
      { status: 500 }
    )
  }
}
