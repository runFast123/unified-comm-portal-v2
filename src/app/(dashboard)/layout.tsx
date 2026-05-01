import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'
import { BackgroundPoller } from '@/components/dashboard/background-poller'
import { KeyboardShortcutProvider } from '@/components/dashboard/keyboard-shortcuts'
import { AdminOnboardingBanner } from '@/components/dashboard/admin-onboarding-banner'
import { isSuperAdmin } from '@/lib/auth'
import type { User } from '@/types/database'
import type { CompanyOption } from '@/components/dashboard/company-switcher'

// Force dynamic rendering — layout must run on every request to compute
// user-specific companyAccountIds (different per user session)
export const dynamic = 'force-dynamic'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createServerSupabaseClient()

  // Check authentication
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  if (!authUser) {
    redirect('/login')
  }

  // Fetch user profile
  const { data: profile } = await supabase
    .from('users')
    .select('*')
    .eq('id', authUser.id)
    .maybeSingle()

  const user: Pick<User, 'email' | 'full_name' | 'role' | 'account_id'> = {
    email: profile?.email ?? authUser.email ?? '',
    full_name: profile?.full_name ?? null,
    role: profile?.role ?? 'viewer',
    account_id: profile?.account_id ?? null,
  }

  const userCompanyId = (profile?.company_id as string | null | undefined) ?? null

  // Fetch sibling account IDs (same company, different channels) for non-admin
  // users — using the proper `accounts.company_id` FK. Uses service-role
  // client because RLS may hide other-channel rows from the user.
  let companyAccountIds: string[] = user.account_id ? [user.account_id] : []
  if (user.role !== 'admin' && user.account_id) {
    try {
      const service = await createServiceRoleClient()
      const { data: myAccount } = await service
        .from('accounts')
        .select('id, name, company_id')
        .eq('id', user.account_id)
        .maybeSingle()

      if (myAccount?.company_id) {
        // Happy path — simple FK query.
        const { data: siblings } = await service
          .from('accounts')
          .select('id')
          .eq('company_id', myAccount.company_id)
          .eq('is_active', true)
        if (siblings && siblings.length > 0) {
          companyAccountIds = siblings.map((s) => s.id as string)
        }
      } else if (myAccount) {
        // Legacy fallback — user's account hasn't been backfilled. Warn and
        // fall back to the old name-substring grouping so we don't break.
        console.warn(
          `[layout] Falling back to name-substring match — account ${user.account_id} ` +
            `has no company_id. Run/verify the companies backfill migration.`
        )
        const { data: allAccounts } = await service
          .from('accounts')
          .select('id, name')
          .eq('is_active', true)
        if (allAccounts && myAccount.name) {
          const stripChannelSuffix = (n: string) =>
            n.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
          const baseName = stripChannelSuffix(myAccount.name as string)
          companyAccountIds = allAccounts
            .filter((a) => stripChannelSuffix(a.name as string) === baseName)
            .map((a) => a.id as string)
        }
      }
    } catch { /* fallback to single account_id */ }
  }

  // Fetch pending reply count (scoped for non-admins)
  let pendingQuery = supabase
    .from('ai_replies')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending_approval')
  if (user.role !== 'admin' && companyAccountIds.length > 0) {
    pendingQuery = pendingQuery.in('account_id', companyAccountIds)
  }
  const { count: pendingCount } = await pendingQuery

  // ── Multi-tenancy: accessible companies + branding ──────────────────
  // super_admin sees all companies; everyone else sees their own (and any
  // additional ones they may eventually be a member of — modeled but rare
  // for now). The result feeds the company switcher dropdown in the header.
  const service = await createServiceRoleClient()
  let accessibleCompanies: CompanyOption[] = []
  try {
    if (isSuperAdmin(user.role as string)) {
      const { data } = await service
        .from('companies')
        .select('id, name, slug, logo_url, accent_color')
        .order('name', { ascending: true })
      accessibleCompanies = ((data as CompanyOption[] | null) ?? [])
    } else if (userCompanyId) {
      const { data } = await service
        .from('companies')
        .select('id, name, slug, logo_url, accent_color')
        .eq('id', userCompanyId)
        .maybeSingle()
      if (data) accessibleCompanies = [data as CompanyOption]
    }
  } catch { /* non-fatal */ }

  // Resolve the "active" company for branding — read from cookie if
  // present and accessible, else fall back to the user's company.
  const cookieStore = await cookies()
  const cookieCompanyId = cookieStore.get('selected_company_id')?.value ?? null
  const activeCompanyId =
    cookieCompanyId && accessibleCompanies.some((c) => c.id === cookieCompanyId)
      ? cookieCompanyId
      : userCompanyId
  const activeCompany = accessibleCompanies.find((c) => c.id === activeCompanyId) ?? null

  // ── Onboarding banner gate ───────────────────────────────────────────
  // Show the one-time hint to fresh super_admins on a clean install
  // (single company in the system). Counts via head:true to avoid
  // pulling rows. Non-fatal — banner just stays hidden if this fails.
  let showOnboardingBanner = false
  if (isSuperAdmin(user.role as string)) {
    try {
      const { count: companyCount } = await service
        .from('companies')
        .select('id', { count: 'exact', head: true })
      if ((companyCount ?? 0) <= 1) showOnboardingBanner = true
    } catch { /* non-fatal */ }
  }

  return (
    <DashboardShell
      user={user}
      pendingCount={pendingCount ?? 0}
      companyAccountIds={companyAccountIds}
      accessibleCompanies={accessibleCompanies}
      currentCompanyId={userCompanyId}
      brandLogoUrl={activeCompany?.logo_url ?? null}
      brandAccentColor={activeCompany?.accent_color ?? null}
      brandCompanyName={activeCompany?.name ?? null}
    >
      {/* One-time onboarding hint for fresh super_admins. Self-hides via
          localStorage once dismissed; renders nothing for non-admins. */}
      <AdminOnboardingBanner show={showOnboardingBanner} />
      {/* Silent timer that fires /api/inbox-sync every 2 min while the tab is visible
          so new mail flows in without the user clicking Sync. */}
      <BackgroundPoller />
      {/* Global keyboard shortcuts + `?` cheatsheet modal. */}
      <KeyboardShortcutProvider />
      {children}
    </DashboardShell>
  )
}
