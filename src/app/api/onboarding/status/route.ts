import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin } from '@/lib/auth'

/**
 * GET /api/onboarding/status
 *
 * Admin-only. Returns the completion state of the 4 onboarding steps,
 * scoped to the caller's company. Previously every count was
 * platform-wide, so a brand-new tenant immediately saw "all done"
 * because some OTHER tenant had already added an account, configured
 * credentials, invited users, etc. That defeats the entire point of the
 * onboarding checklist and also leaks the existence of other tenants.
 *
 * Scoping:
 *   - accounts → filtered by company_id directly.
 *   - channel_configs → has no company_id; joined via the account_id set
 *     for the caller's company.
 *   - users → filtered by company_id.
 *   - messages → has no company_id; joined via the account_id set.
 *
 * super_admin is intentionally scoped to their own company too. They
 * rarely use this endpoint (it's a tenant-onboarding tool), and showing
 * them platform-wide stats would put us right back where we started.
 */
export async function GET() {
  // Session check — must be logged in
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Role + company scoping. We use getCurrentUser() so we have company_id
  // in one round-trip alongside the role check.
  const profile = await getCurrentUser(user.id)
  if (!profile || !isCompanyAdmin(profile.role)) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  let companyId = profile.company_id
  if (!companyId && profile.role === 'super_admin') {
    // super_admin has no company on their profile. Honor the tenant
    // switcher cookie (like the other admin routes) so the checklist shows
    // the SELECTED company's real progress.
    companyId = (await cookies()).get('selected_company_id')?.value?.trim() || null
  }
  if (!companyId) {
    // No company attached and none selected (e.g. super_admin combined
    // view) → there is no workspace to onboard. Report allComplete so the
    // checklist self-hides instead of nagging "0 of 4" forever.
    return NextResponse.json({
      steps: [
        { id: 'add_account', complete: true },
        { id: 'configure_credentials', complete: true },
        { id: 'invite_teammate', complete: true },
        { id: 'first_reply', complete: true },
      ],
      allComplete: true,
    })
  }

  const admin = await createServiceRoleClient()

  // Resolve the company's accounts up front. We need this for the two
  // queries that hang off account_id (channel_configs, messages) and for
  // step 1 (accounts count).
  const { data: companyAccounts } = await admin
    .from('accounts')
    .select('id')
    .eq('company_id', companyId)
  const companyAccountIds = (companyAccounts ?? []).map((a) => a.id as string)

  // If the company has zero accounts, the credentials + first-reply
  // queries would 400 with `in: ()`, so short-circuit them to 0.
  const hasAccounts = companyAccountIds.length > 0

  const credsPromise = hasAccounts
    ? admin
        .from('channel_configs')
        .select('account_id', { count: 'exact', head: true })
        .in('account_id', companyAccountIds)
        .not('config_encrypted', 'is', null)
    : Promise.resolve({ count: 0 })

  const outboundPromise = hasAccounts
    ? admin
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .in('account_id', companyAccountIds)
        .eq('direction', 'outbound')
        .eq('sender_type', 'agent')
    : Promise.resolve({ count: 0 })

  // Run all four detection queries in parallel (where possible).
  const [credsRes, usersRes, outboundRes] = await Promise.all([
    credsPromise,
    admin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId),
    outboundPromise,
  ])

  const steps = [
    { id: 'add_account', complete: companyAccountIds.length > 0 },
    { id: 'configure_credentials', complete: (credsRes.count ?? 0) > 0 },
    { id: 'invite_teammate', complete: (usersRes.count ?? 0) > 1 },
    { id: 'first_reply', complete: (outboundRes.count ?? 0) > 0 },
  ]

  const allComplete = steps.every((s) => s.complete)

  return NextResponse.json({ steps, allComplete })
}
