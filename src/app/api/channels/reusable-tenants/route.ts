import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getChannelConfig, type Channel } from '@/lib/channel-config'

async function requireAdmin() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin.from('users').select('role, company_id').eq('id', user.id).maybeSingle()
  if (!['admin','super_admin','company_admin'].includes(profile?.role ?? '')) return { ok: false as const, status: 403, error: 'Admin only' }
  return {
    ok: true as const,
    userId: user.id,
    role: (profile?.role as string | null) ?? null,
    companyId: (profile?.company_id as string | null) ?? null,
  }
}

// GET /api/channels/reusable-tenants?channel=teams
// Returns a deduped list of existing Teams accounts that have Azure creds
// saved, with only the non-secret tenant_id exposed (for dropdown display).
// Never returns client_id or client_secret.
export async function GET(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const url = new URL(request.url)
  const channel = url.searchParams.get('channel') as Channel | null
  if (channel !== 'teams') {
    // Reuse is currently only meaningful for Teams (tenant-level creds).
    return NextResponse.json({ tenants: [] })
  }

  const admin = await createServiceRoleClient()
  let accountsQuery = admin
    .from('accounts')
    .select('id, name')
    .eq('channel_type', 'teams')
    .eq('is_active', true)
    .order('name')
  // Tenant scope: a company_admin may only reuse Azure creds from their OWN
  // company's accounts. Only super_admin sees every tenant's Teams accounts.
  if (gate.role !== 'super_admin') {
    if (!gate.companyId) return NextResponse.json({ tenants: [] })
    accountsQuery = accountsQuery.eq('company_id', gate.companyId)
  }
  const { data: accounts, error } = await accountsQuery
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Pre-fetch which accounts actually have a DB-saved config row so we skip
  // env-fallback matches (env creds aren't per-account and don't need copying).
  const { data: configs } = await admin
    .from('channel_configs')
    .select('account_id')
    .eq('channel', 'teams')
  const withDbConfig = new Set((configs ?? []).map((c) => c.account_id as string))

  const seen = new Set<string>()
  const tenants: Array<{ source_account_id: string; source_account_name: string; tenant_id: string }> = []
  for (const a of accounts ?? []) {
    if (!withDbConfig.has(a.id)) continue
    const cfg = await getChannelConfig(a.id, 'teams')
    if (!cfg?.azure_tenant_id || !cfg.azure_client_id || !cfg.azure_client_secret) continue
    // Dedupe by tenant_id so admins don't see six rows for the same tenant.
    if (seen.has(cfg.azure_tenant_id)) continue
    seen.add(cfg.azure_tenant_id)
    tenants.push({
      source_account_id: a.id,
      source_account_name: a.name,
      tenant_id: cfg.azure_tenant_id,
    })
  }

  return NextResponse.json({ tenants })
}
