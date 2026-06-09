// GET /api/admin/livechat/stats — company-scoped live-chat analytics.
// requireCompanyAdmin + service-role; every query is pinned to the company's own
// livechat account_id (resolved from company_id), so no cross-tenant data leaks.
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireCompanyAdmin } from '@/lib/tenant-guard'

const OPEN_STATUSES = ['active', 'in_progress', 'waiting_on_customer', 'escalated']

async function resolveTargetCompanyId(
  request: Request,
  ctx: { companyId: string | null; isSuperAdmin: boolean }
): Promise<string> {
  let target = ctx.companyId || ''
  if (ctx.isSuperAdmin) {
    const q = new URL(request.url).searchParams.get('company_id')
    if (q) target = q
    else target = (await cookies()).get('selected_company_id')?.value?.trim() || ctx.companyId || ''
  }
  return target
}

export async function GET(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const companyId = await resolveTargetCompanyId(request, gate.ctx)
  if (!companyId) return NextResponse.json({ stats: null })

  const admin = await createServiceRoleClient()
  // Stats are per-widget: an explicit ?account_id= (verified to belong to this
  // company) or, if omitted, the company's first livechat account.
  const reqAccountId = new URL(request.url).searchParams.get('account_id')
  let accountId: string | null = null
  if (reqAccountId) {
    const { data: acct } = await admin
      .from('accounts')
      .select('id')
      .eq('id', reqAccountId)
      .eq('company_id', companyId)
      .eq('channel_type', 'livechat')
      .maybeSingle()
    accountId = acct ? reqAccountId : null
  } else {
    const { data: acct } = await admin
      .from('accounts')
      .select('id')
      .eq('channel_type', 'livechat')
      .eq('company_id', companyId)
      .limit(1)
      .maybeSingle()
    accountId = (acct as { id: string } | null)?.id ?? null
  }
  if (!accountId) return NextResponse.json({ stats: null })

  const now = Date.now()
  const sevenDaysAgo = new Date(now - 7 * 86400000).toISOString()
  const fourteenDaysAgo = new Date(now - 14 * 86400000).toISOString()

  // Each call builds a fresh query, all pinned to (accountId, channel='livechat').
  const conv = () =>
    admin.from('conversations').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('channel', 'livechat')
  const msg = () =>
    admin.from('messages').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('channel', 'livechat')

  const [totalC, weekC, openC, inboundC, outboundC, recentRes, volRes] = await Promise.all([
    conv(),
    conv().gte('created_at', sevenDaysAgo),
    conv().in('status', OPEN_STATUSES),
    msg().eq('direction', 'inbound'),
    msg().eq('direction', 'outbound'),
    admin
      .from('conversations')
      .select('id, participant_name, status, last_message_at')
      .eq('account_id', accountId)
      .eq('channel', 'livechat')
      .order('last_message_at', { ascending: false })
      .limit(6),
    admin
      .from('conversations')
      .select('created_at')
      .eq('account_id', accountId)
      .eq('channel', 'livechat')
      .gte('created_at', fourteenDaysAgo)
      .limit(5000),
  ])

  // Daily volume buckets for the last 14 days.
  const buckets: Record<string, number> = {}
  for (let i = 13; i >= 0; i--) buckets[new Date(now - i * 86400000).toISOString().slice(0, 10)] = 0
  for (const c of (volRes.data ?? []) as { created_at: string | null }[]) {
    const d = (c.created_at || '').slice(0, 10)
    if (d in buckets) buckets[d]++
  }
  const dailyVolume = Object.entries(buckets).map(([date, count]) => ({ date, count }))

  return NextResponse.json({
    stats: {
      totalConversations: totalC.count ?? 0,
      conversationsThisWeek: weekC.count ?? 0,
      openConversations: openC.count ?? 0,
      inboundMessages: inboundC.count ?? 0,
      outboundMessages: outboundC.count ?? 0,
      recent: ((recentRes.data ?? []) as { id: string; participant_name: string | null; status: string | null; last_message_at: string | null }[]).map((c) => ({
        id: c.id,
        name: c.participant_name || 'Website visitor',
        status: c.status || 'active',
        at: c.last_message_at,
      })),
      dailyVolume,
    },
  })
}
