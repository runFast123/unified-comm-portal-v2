import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { getCurrentUser, isSuperAdmin } from '@/lib/auth'

/**
 * Server-side super_admin gate for /admin/integrations.
 *
 * The `integrations` table holds platform-wide OAuth client credentials
 * (Google Cloud OAuth client, Azure App Registration) shared by EVERY
 * tenant. A company_admin must not be able to rotate the OAuth app used
 * by other companies, so we restrict this surface to super_admin only.
 *
 * The matching API guard lives in `src/app/api/integrations/**`. UI
 * visibility is also gated in `src/components/dashboard/sidebar.tsx`.
 *
 * TODO(multi-tenant): future work could add a `company_id` column to
 * `integrations` and let each tenant configure its own OAuth client. For
 * now we keep the table platform-wide and lock the UI to super_admin.
 */
export default async function IntegrationsAdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createServerSupabaseClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()
  if (!authUser) redirect('/login')

  const profile = await getCurrentUser(authUser.id)
  if (!isSuperAdmin(profile?.role)) {
    redirect('/dashboard')
  }

  return <>{children}</>
}
