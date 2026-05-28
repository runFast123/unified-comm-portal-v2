import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import NotificationsClient from './notifications-client'

export const dynamic = 'force-dynamic'

/**
 * Notification rules — company_admin or super_admin only.
 *
 * The /admin layout already gates this, but we resolve the caller's
 * company account ids here so the client can scope every read/write/delete
 * on `notification_rules` to those accounts. This is defense-in-depth on
 * top of RLS.
 *
 * For super_admin: resolves to the cookie-selected company from the
 * company switcher (falling back to unscoped null when no cookie is set,
 * preserving the cross-tenant view).
 */
export default async function NotificationsPage() {
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

  let companyAccountIds: string[] | null = null
  if (activeCompanyId) {
    const admin = await createServiceRoleClient()
    const { data: rows } = await admin
      .from('accounts')
      .select('id')
      .eq('company_id', activeCompanyId)
    companyAccountIds = ((rows as Array<{ id: string }> | null) ?? []).map((r) => r.id)
  } else if (!isSuperAdmin(profile?.role)) {
    // company_admin with no company_id — misconfigured. Render but no-op.
    companyAccountIds = []
  }
  // super_admin with no active company (no cookie + no home company) →
  // companyAccountIds stays null → cross-tenant view preserved.

  return <NotificationsClient companyAccountIds={companyAccountIds} />
}
