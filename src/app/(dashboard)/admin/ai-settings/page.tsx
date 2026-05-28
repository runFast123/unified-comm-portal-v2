import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
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
 * For super_admin: resolves the active company from the switcher cookie
 * so the per-tenant ai_config row + scoped account writes follow the
 * switcher selection. Falls back to the super_admin's home company when
 * no cookie is set.
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

  // Resolve the active company id — for super_admin it comes from the
  // switcher cookie; for company_admin it's their own company.
  let activeCompanyId: string | null = profile?.company_id ?? null
  if (isSuperAdmin(profile?.role)) {
    const cookieStore = await cookies()
    const cookieCompanyId = cookieStore.get('selected_company_id')?.value ?? null
    activeCompanyId = cookieCompanyId ?? profile?.company_id ?? null
  }

  // Resolve the set of account ids this caller is allowed to mutate.
  //   - active company → ids of accounts whose company_id matches
  //   - super_admin with no active company → null (cross-tenant; allow all)
  //   - company_admin with no company → empty (no-op writes)
  let companyAccountIds: string[] | null = null
  if (activeCompanyId) {
    const admin = await createServiceRoleClient()
    const { data: rows } = await admin
      .from('accounts')
      .select('id')
      .eq('company_id', activeCompanyId)
    companyAccountIds = ((rows as Array<{ id: string }> | null) ?? []).map((r) => r.id)
  } else if (!isSuperAdmin(profile?.role)) {
    companyAccountIds = []
  }

  // Resolve the company_id used to scope ai_config reads/writes.
  //   - super_admin → cookie-selected company (or home company as fallback)
  //   - company_admin → their company_id (guaranteed non-null by the access
  //     check above + RLS, but we pass null when missing to keep the client
  //     defensive).
  const companyId: string | null = activeCompanyId

  return <AISettingsClient companyAccountIds={companyAccountIds} companyId={companyId} />
}
