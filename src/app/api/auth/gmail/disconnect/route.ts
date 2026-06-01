import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getChannelConfig, saveChannelConfig, type EmailConfig } from '@/lib/channel-config'
import { verifyAccountAccess } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

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
  if (!['admin','super_admin','company_admin'].includes(profile?.role ?? '')) return { ok: false as const, status: 403, error: 'Admin only' }
  return { ok: true as const, userId: user.id }
}

async function doDisconnect(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const url = new URL(request.url)
  const accountId = url.searchParams.get('account_id')
  if (!accountId) {
    return NextResponse.json({ error: 'account_id required' }, { status: 400 })
  }

  // Tenant scope: this route uses the service-role client, so verify the
  // caller's company owns the account before reading/rewriting its config.
  if (!(await verifyAccountAccess(gate.userId, accountId))) {
    return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
  }

  const existing = (await getChannelConfig(accountId, 'email')) as EmailConfig | null
  if (!existing) {
    return NextResponse.json({ error: 'No email config to disconnect' }, { status: 404 })
  }

  // Strip google_* fields, flip auth_mode back to 'smtp'. Preserve the
  // rest of the config so a user who re-adds an app password is back in
  // business without reconfiguring hosts/ports.
  const stripped: EmailConfig = {
    smtp_host: existing.smtp_host,
    smtp_port: existing.smtp_port,
    smtp_secure: existing.smtp_secure,
    smtp_user: existing.smtp_user,
    smtp_password: existing.smtp_password,
    smtp_from_name: existing.smtp_from_name,
    imap_host: existing.imap_host,
    imap_port: existing.imap_port,
    imap_secure: existing.imap_secure,
    imap_user: existing.imap_user,
    imap_password: existing.imap_password,
    auth_mode: 'smtp',
  }

  try {
    await saveChannelConfig(accountId, 'email', stripped)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save config' },
      { status: 500 }
    )
  }

  try {
    const admin = await createServiceRoleClient()
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'gmail.oauth.disconnected',
      entity_type: 'channel_config',
      entity_id: null,
      details: { account_id: accountId, channel: 'email' },
    })
  } catch {
    /* ignore audit failure */
  }

  return NextResponse.json({ success: true })
}

export async function POST(request: Request) {
  return doDisconnect(request)
}

export async function DELETE(request: Request) {
  return doDisconnect(request)
}
