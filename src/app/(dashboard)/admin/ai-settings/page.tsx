import { redirect } from 'next/navigation'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import AISettingsClient from './ai-settings-client'

export const dynamic = 'force-dynamic'

/**
 * AI Settings — company_admin or super_admin only.
 *
 * Privilege check happens here (server-side); viewers/members are
 * redirected to /dashboard. We also resolve the caller's company account
 * IDs server-side so the client can scope its per-channel account updates
 * to its own company instead of mutating every tenant's rows.
 *
 * Pattern mirrors src/app/(dashboard)/admin/companies/page.tsx +
 * src/app/(dashboard)/admin/webhooks/page.tsx.
 */
export default async function AISettingsPage() {
  const supabase = await createServerSupabaseClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()
  if (!authUser) redirect('/login')

  const profile = await getCurrentUser(authUser.id)
  if (!isSuperAdmin(profile?.role) && !isCompanyAdmin(profile?.role)) {
    redirect('/dashboard')
  }

  // Resolve the set of account ids this caller is allowed to mutate.
  //   - super_admin → null sentinel (no scope; allow all)
  //   - company_admin → ids of accounts whose company_id matches theirs
  let companyAccountIds: string[] | null = null
  if (!isSuperAdmin(profile?.role)) {
    if (!profile?.company_id) {
      // company_admin with no company is a misconfiguration; render the
      // form but disallow account writes by passing an empty array.
      companyAccountIds = []
    } else {
      const admin = await createServiceRoleClient()
      const { data: rows } = await admin
        .from('accounts')
        .select('id')
        .eq('company_id', profile.company_id)
      companyAccountIds = ((rows as Array<{ id: string }> | null) ?? []).map((r) => r.id)
    }
  }

  // Resolve the company_id used to scope ai_config reads/writes.
  //   - super_admin → scope to their own company by default. They can still
  //     edit other tenants via SQL or a future tenant picker.
  //   - company_admin → their company_id (guaranteed non-null by the access
  //     check above + RLS, but we pass null when missing to keep the client
  //     defensive).
  const companyId: string | null = profile?.company_id ?? null

  return <AISettingsClient companyAccountIds={companyAccountIds} companyId={companyId} />
}
