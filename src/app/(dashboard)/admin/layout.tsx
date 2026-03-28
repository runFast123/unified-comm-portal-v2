import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase-server'

/**
 * Server-side admin layout guard.
 * Checks that the authenticated user has the 'admin' role before
 * rendering any admin pages. Non-admin users are redirected to /dashboard.
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

  // Query the users table to verify admin role
  const { data: profile } = await supabase
    .from('users')
    .select('role')
    .eq('id', authUser.id)
    .maybeSingle()

  if (!profile || profile.role !== 'admin') {
    redirect('/dashboard')
  }

  return <>{children}</>
}
