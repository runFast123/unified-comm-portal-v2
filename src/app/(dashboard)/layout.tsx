import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'
import type { User } from '@/types/database'

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

  // Fetch pending reply count (scoped for non-admins)
  let pendingQuery = supabase
    .from('ai_replies')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending_approval')
  if (user.role !== 'admin' && user.account_id) {
    pendingQuery = pendingQuery.eq('account_id', user.account_id)
  }
  const { count: pendingCount } = await pendingQuery

  return (
    <DashboardShell user={user} pendingCount={pendingCount ?? 0}>
      {children}
    </DashboardShell>
  )
}
