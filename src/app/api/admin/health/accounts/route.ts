import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/health/accounts
 *
 * Admin-only. Returns per-account poller health: when each account was last
 * polled, current consecutive-failure counter (≥5 trips the breaker — see
 * `src/lib/email-poller.ts`), the most recent poll error message, and
 * whether the account has a saved `channel_configs` row at all.
 *
 * The "no channel_configs row" check catches the most common confusion:
 * the account exists in the dashboard but no one ever filled in SMTP/IMAP
 * or saved Teams credentials, so the poller keeps logging "no config".
 */
async function requireAdmin() {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  if (profile?.role !== 'admin') return { ok: false as const, status: 403, error: 'Admin only' }
  return { ok: true as const }
}

interface AccountHealth {
  id: string
  name: string
  channel_type: 'email' | 'teams' | 'whatsapp'
  is_active: boolean
  last_polled_at: string | null
  consecutive_poll_failures: number
  last_poll_error: string | null
  last_poll_error_at: string | null
  has_channel_config: boolean
}

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = await createServiceRoleClient()

  const { data: accounts, error: aErr } = await admin
    .from('accounts')
    .select(
      'id, name, channel_type, is_active, last_polled_at, consecutive_poll_failures, last_poll_error, last_poll_error_at'
    )
    .order('name', { ascending: true })

  if (aErr || !accounts) {
    return NextResponse.json(
      { error: aErr?.message ?? 'Failed to load accounts' },
      { status: 500 }
    )
  }

  // Pull all channel_config rows in ONE query rather than N+1; the table is
  // tiny and we just need to know which (account_id, channel) pairs exist.
  const { data: configs } = await admin
    .from('channel_configs')
    .select('account_id, channel')

  const configKey = (id: string, channel: string) => `${id}:${channel}`
  const configSet = new Set(
    (configs ?? []).map((c) => configKey(c.account_id as string, c.channel as string))
  )

  const enriched: AccountHealth[] = accounts.map((a) => ({
    id: a.id as string,
    name: (a.name as string) ?? '',
    channel_type: a.channel_type as 'email' | 'teams' | 'whatsapp',
    is_active: !!a.is_active,
    last_polled_at: (a.last_polled_at as string) ?? null,
    consecutive_poll_failures: (a.consecutive_poll_failures as number) ?? 0,
    last_poll_error: (a.last_poll_error as string) ?? null,
    last_poll_error_at: (a.last_poll_error_at as string) ?? null,
    has_channel_config: configSet.has(configKey(a.id as string, a.channel_type as string)),
  }))

  return NextResponse.json({ accounts: enriched })
}
