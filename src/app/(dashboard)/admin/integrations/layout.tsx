import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

/**
 * Server-side admin gate for /admin/integrations.
 *
 * The `integration_settings` table is now PER-COMPANY (migration
 * 20260528170000_integrations_per_company.sql) — each tenant owns its
 * own Google/Azure OAuth client rows. That means company_admin needs
 * access to manage their own rows; super_admin still has cross-tenant
 * access via the switcher cookie.
 *
 * RLS enforces the row-level boundary; this gate just keeps non-admins
 * out of the UI entirely.
 *
 * The matching API guard lives in `src/app/api/integrations/**`. UI
 * visibility is also gated in `src/components/dashboard/sidebar.tsx`.
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
  if (!isSuperAdmin(profile?.role) && !isCompanyAdmin(profile?.role)) {
    redirect('/dashboard')
  }

  return <>{children}</>
}
