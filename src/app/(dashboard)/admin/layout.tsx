import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { isCompanyAdmin } from '@/lib/auth'

/**
 * Server-side admin layout guard.
 *
 * Allows the legacy `admin`, the new `company_admin`, and `super_admin`
 * roles to enter /admin/*. Non-admin users are redirected to /dashboard.
 *
 * Per-page gating (e.g. companies list is super_admin only) lives inside
 * the individual pages and API routes.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createServerSupabaseClient()

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  if (!authUser) {
    redirect('/login')
  }

  // Query the users table to verify admin role. Allow legacy admin,
  // company_admin, and super_admin.
  const { data: profile } = await supabase
    .from('users')
    .select('role')
    .eq('id', authUser.id)
    .maybeSingle()

  if (!profile || !isCompanyAdmin(profile.role as string | null | undefined)) {
    redirect('/dashboard')
  }

  return <>{children}</>
}
