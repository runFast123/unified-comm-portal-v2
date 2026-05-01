/**
 * GET /api/csat/aggregate?scope=company|agent&id=<uuid>&days=<n>
 *
 * Auth-gated. Returns the CSAT aggregate (avg, total_sent, total_responded,
 * response_rate, distribution{1..5}) for either:
 *   - scope=company&id=<companyId>  → company-wide rollup
 *   - scope=agent&id=<userId>       → per-agent rollup
 *
 * `days` is optional (defaults to 30). When provided, limits to surveys
 * sent in the last N days.
 *
 * Authorization:
 *   - super_admin → any scope/id
 *   - company_admin / admin / company_member → only their own company,
 *     or any agent within their own company.
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isSuperAdmin } from '@/lib/auth'
import { companyCSATAggregate, agentCSATAggregate } from '@/lib/csat'

export async function GET(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(request.url)
    const scope = url.searchParams.get('scope')
    const id = url.searchParams.get('id')
    const daysParam = url.searchParams.get('days')

    if (scope !== 'company' && scope !== 'agent') {
      return NextResponse.json(
        { error: 'scope must be "company" or "agent"' },
        { status: 400 }
      )
    }
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const days = daysParam ? Math.max(1, Math.min(365, Number(daysParam) || 30)) : 30
    const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const profile = await getCurrentUser(user.id)
    if (!profile) {
      return NextResponse.json({ error: 'No profile' }, { status: 403 })
    }
    const isSA = isSuperAdmin(profile.role)

    const admin = await createServiceRoleClient()

    if (scope === 'company') {
      if (!isSA && profile.company_id !== id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      const agg = await companyCSATAggregate(admin, id, dateFrom)
      return NextResponse.json({ aggregate: agg })
    }

    // scope === 'agent'
    if (!isSA) {
      const { data: targetUser } = await admin
        .from('users')
        .select('company_id')
        .eq('id', id)
        .maybeSingle()
      const targetCompanyId = (targetUser as { company_id: string | null } | null)?.company_id
      if (!profile.company_id || targetCompanyId !== profile.company_id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }
    const agg = await agentCSATAggregate(admin, id, dateFrom)
    return NextResponse.json({ aggregate: agg })
  } catch (err) {
    console.error('CSAT aggregate error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
