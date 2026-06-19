import { redirect } from 'next/navigation'
import { cookies, headers } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'
import { BackgroundPoller } from '@/components/dashboard/background-poller'
import { KeyboardShortcutProvider } from '@/components/dashboard/keyboard-shortcuts'
import { AdminOnboardingBanner } from '@/components/dashboard/admin-onboarding-banner'
import { isSuperAdmin } from '@/lib/auth'
import { getEffectivePermissions } from '@/lib/permissions/server'
import { sectionForPath, firstAccessibleRoute } from '@/lib/permissions/routes'
import type { User, UserRole } from '@/types/database'
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

  // ── MFA enforce-for-enrolled (Stage 1) ───────────────────────────────
  // A user with a verified second factor whose session is still aal1 (hasn't
  // stepped up this session) must complete the TOTP challenge before reaching
  // any dashboard page. This applies to ALL roles (incl. super_admin).
  //
  // FAIL-OPEN (critical): the AAL probe is wrapped in try/catch. On ANY error
  // we do NOT redirect — a transient GoTrue/network blip must never lock users
  // out. We compute `needsStepUp` inside the try and call redirect() OUTSIDE
  // it, because redirect() throws NEXT_REDIRECT internally and a surrounding
  // catch would otherwise swallow the redirect.
  //
  // Loop-safety: we never redirect when already on the challenge page. The
  // challenge page lives under (dashboard) too, so without this guard the gate
  // would fire on /account/verify-2fa itself and loop forever.
  const reqHeadersForMfa = await headers()
  const mfaPath = reqHeadersForMfa.get('x-pathname') ?? ''
  const onVerifyPage = mfaPath === '/account/verify-2fa' || mfaPath.startsWith('/account/verify-2fa/')
  if (!onVerifyPage) {
    let needsStepUp = false
    try {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal && aal.currentLevel === 'aal1' && aal.nextLevel === 'aal2') {
        needsStepUp = true
      }
    } catch {
      // Fail OPEN — do not redirect on error.
      needsStepUp = false
    }
    if (needsStepUp) {
      redirect('/account/verify-2fa')
    }
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

  // ── RBAC: resolve effective permissions + guard the requested route ──
  // Effective set = code baseline (mirrors today's gating) + sparse DB overrides.
  const effectivePerms = await getEffectivePermissions({
    id: authUser.id,
    role: user.role as UserRole,
    company_id: userCompanyId,
  })
  // Server route guard: block direct navigation to a section the user lacks.
  // super_admin is all-access; default permissions mirror today, so no redirect
  // happens until an admin explicitly restricts access. firstAccessibleRoute only
  // returns routes the user CAN reach, so this can't loop.
  if (user.role !== 'super_admin') {
    const currentPath = mfaPath
    const section = sectionForPath(currentPath)
    if (section && !effectivePerms.has(section)) {
      const fallback = firstAccessibleRoute(effectivePerms)
      if (fallback !== currentPath) redirect(fallback)
    }
  }
  const permissions = [...effectivePerms]

  // ── Multi-tenancy: accessible companies + branding ──────────────────
  // super_admin sees all companies; everyone else sees their own (and any
  // additional ones they may eventually be a member of — modeled but rare
  // for now). The result feeds the company switcher dropdown in the header.
  //
  // We resolve `accessibleCompanies` and `activeCompanyId` BEFORE computing
  // `companyAccountIds` so the cookie-selected company (set by the switcher
  // in the header) actually drives data scoping for ALL users, not just
  // branding. Without this, super_admin's `companyAccountIds` would always
  // be `[user.account_id]` (their MCM home account) regardless of which
  // tenant they picked in the switcher — the dashboard/inbox/reports would
  // keep showing MCM data after switching to e.g. Acme.
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

  // Resolve the "active" company.
  //
  // Semantics — the matrix the consumer pages depend on:
  //   - super_admin + cookie matching an accessible company → that id
  //   - super_admin + no cookie (or stale/invalid cookie)   → null
  //     → "combined view": no tenant scope; queries run cross-tenant
  //   - non-admin → userCompanyId (their home company); fall back to the
  //     first accessible company when home company is missing. Non-admins
  //     can NEVER reach the `null` (combined view) state — their switcher
  //     is hidden in the header anyway.
  const cookieStore = await cookies()
  const cookieCompanyId = cookieStore.get('selected_company_id')?.value ?? null
  const userIsSuperAdmin = isSuperAdmin(user.role as string)
  let activeCompanyId: string | null
  if (userIsSuperAdmin) {
    // super_admin: cookie wins when it points to a real accessible company,
    // otherwise null = combined view (DEFAULT for fresh logins).
    activeCompanyId =
      cookieCompanyId && accessibleCompanies.some((c) => c.id === cookieCompanyId)
        ? cookieCompanyId
        : null
  } else {
    // Non-admin: pinned to their home company. Fall back to first accessible
    // if the home column is null but they happen to have access to one.
    activeCompanyId = userCompanyId ?? accessibleCompanies[0]?.id ?? null
  }
  const activeCompany = activeCompanyId
    ? accessibleCompanies.find((c) => c.id === activeCompanyId) ?? null
    : null

  // Resolve `companyAccountIds` for the ACTIVE company.
  //
  // Gating rules (paired with consumer pages):
  //   - activeCompanyId === null → `[]`. Consumer pages MUST NOT apply
  //     `.in('account_id', [])` here — they gate on `activeCompanyId`,
  //     not on `companyAccountIds.length`. An empty array reaching a
  //     consumer means "real tenant, zero accounts → no rows", which
  //     would silently fall through to an unscoped query under the old
  //     `length > 0` gate (the bug we're fixing).
  //   - activeCompanyId set → query accounts.id for that company. May be
  //     `[]` for a freshly-created tenant. That `[]` IS correct here —
  //     consumer pages will pass it to `.in('account_id', [])` and get
  //     zero rows back (the correct answer).
  //   - Legacy fallback (account lacking company_id) only kicks in when
  //     activeCompanyId resolves to a real company AND the FK lookup
  //     returns nothing AND the user's own account has no company_id.
  let companyAccountIds: string[] = []
  try {
    if (activeCompanyId) {
      const { data: siblings } = await service
        .from('accounts')
        .select('id')
        .eq('company_id', activeCompanyId)
        .eq('is_active', true)
      companyAccountIds = ((siblings as Array<{ id: string }> | null) ?? []).map((s) => s.id)

      // Legacy fallback — user's account hasn't been backfilled with
      // company_id and the FK lookup turned up empty. Walk the name-
      // substring grouping to avoid breaking tenants pre-migration.
      // Only applies for the user's OWN active company.
      if (
        companyAccountIds.length === 0 &&
        user.account_id &&
        activeCompanyId === userCompanyId
      ) {
        const { data: myAccount } = await service
          .from('accounts')
          .select('id, name, company_id')
          .eq('id', user.account_id)
          .maybeSingle()

        if (myAccount && !myAccount.company_id) {
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
      }
    }
    // activeCompanyId === null → combined view → keep `[]`. Consumers
    // gate on activeCompanyId, so they will skip the `.in()` filter.
  } catch { /* fallback to empty scope */ }

  // Fetch pending reply count — scope to the active company's accounts
  // when a tenant is selected. In combined view (super_admin, activeCompanyId
  // === null) we leave the query unscoped so the badge reflects everything.
  let pendingQuery = supabase
    .from('ai_replies')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending_approval')
  if (activeCompanyId) {
    pendingQuery = pendingQuery.in('account_id', companyAccountIds)
  }
  const { count: pendingCount } = await pendingQuery

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
      activeCompanyId={activeCompanyId}
      canSeeAllCompanies={userIsSuperAdmin}
      accessibleCompanies={accessibleCompanies}
      currentCompanyId={userCompanyId}
      brandLogoUrl={activeCompany?.logo_url ?? null}
      brandAccentColor={activeCompany?.accent_color ?? null}
      brandCompanyName={activeCompany?.name ?? null}
      permissions={permissions}
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
