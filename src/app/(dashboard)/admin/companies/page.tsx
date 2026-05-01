import { redirect } from 'next/navigation'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isSuperAdmin } from '@/lib/auth'
import { CompaniesAdminClient, type CompanyRow } from './companies-client'

// Force dynamic — this page must reflect live counts on each visit.
export const dynamic = 'force-dynamic'

/**
 * Companies list — super_admin only. Shows every company with a quick
 * count of accounts, users, and current-month AI spend.
 *
 * Privilege check happens here (server-side); page redirects non-super
 * admins to /dashboard.
 */
export default async function CompaniesAdminPage() {
  const supabase = await createServerSupabaseClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()
  if (!authUser) redirect('/login')

  const profile = await getCurrentUser(authUser.id)
  if (!isSuperAdmin(profile?.role)) {
    redirect('/dashboard')
  }

  const admin = await createServiceRoleClient()

  // Companies + the few fields we render in the table.
  const { data: companies } = await admin
    .from('companies')
    .select('id, name, slug, logo_url, accent_color, monthly_ai_budget_usd, created_at')
    .order('name', { ascending: true })

  const list = (companies as Array<{
    id: string
    name: string
    slug: string | null
    logo_url: string | null
    accent_color: string | null
    monthly_ai_budget_usd: number | null
    created_at: string
  }> | null) ?? []

  // Counts via parallel queries. Done with `head: true, count: 'exact'` so we
  // don't transfer rows.
  const accountsByCompany: Record<string, number> = {}
  const usersByCompany: Record<string, number> = {}
  const spendByCompany: Record<string, number> = {}

  if (list.length > 0) {
    // Accounts grouped by company_id (single query, in-memory bucket).
    const { data: accountsRows } = await admin
      .from('accounts')
      .select('id, company_id')
      .in('company_id', list.map((c) => c.id))
    for (const row of (accountsRows as Array<{ id: string; company_id: string }> | null) ?? []) {
      accountsByCompany[row.company_id] = (accountsByCompany[row.company_id] ?? 0) + 1
    }

    // Users grouped by company_id.
    const { data: usersRows } = await admin
      .from('users')
      .select('id, company_id')
      .in('company_id', list.map((c) => c.id))
    for (const row of (usersRows as Array<{ id: string; company_id: string | null }> | null) ?? []) {
      if (row.company_id) {
        usersByCompany[row.company_id] = (usersByCompany[row.company_id] ?? 0) + 1
      }
    }

    // Current-month AI spend, summed per account → company. Bounded by
    // current-month start to avoid scanning everything.
    const since = new Date()
    since.setUTCDate(1)
    since.setUTCHours(0, 0, 0, 0)
    const accountToCompany: Record<string, string> = {}
    for (const row of (accountsRows as Array<{ id: string; company_id: string }> | null) ?? []) {
      accountToCompany[row.id] = row.company_id
    }

    if (Object.keys(accountToCompany).length > 0) {
      const { data: usage } = await admin
        .from('ai_usage')
        .select('account_id, estimated_cost_usd')
        .in('account_id', Object.keys(accountToCompany))
        .gte('ts', since.toISOString())
      for (const row of (usage as Array<{
        account_id: string
        estimated_cost_usd: number | null
      }> | null) ?? []) {
        const cId = accountToCompany[row.account_id]
        if (!cId) continue
        spendByCompany[cId] = (spendByCompany[cId] ?? 0) + Number(row.estimated_cost_usd ?? 0)
      }
    }
  }

  const rows: CompanyRow[] = list.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    logo_url: c.logo_url,
    accent_color: c.accent_color,
    monthly_ai_budget_usd: c.monthly_ai_budget_usd,
    created_at: c.created_at,
    accounts_count: accountsByCompany[c.id] ?? 0,
    users_count: usersByCompany[c.id] ?? 0,
    monthly_ai_spend_usd: spendByCompany[c.id] ?? 0,
  }))

  return <CompaniesAdminClient initialCompanies={rows} />
}
