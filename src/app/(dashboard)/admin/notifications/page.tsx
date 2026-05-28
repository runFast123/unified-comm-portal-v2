import { redirect } from 'next/navigation'
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
 */
export default async function NotificationsPage() {
  const supabase = await createServerSupabaseClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()
  if (!authUser) redirect('/login')

  const profile = await getCurrentUser(authUser.id)
  if (!isSuperAdmin(profile?.role) && !isCompanyAdmin(profile?.role)) {
    redirect('/dashboard')
  }

  let companyAccountIds: string[] | null = null
  if (!isSuperAdmin(profile?.role)) {
    if (!profile?.company_id) {
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

  return <NotificationsClient companyAccountIds={companyAccountIds} />
}
