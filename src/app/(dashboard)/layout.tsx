import { redirect } from 'next/navigation'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
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

  // Fetch sibling account IDs (same company, different channels) for non-admin users
  // Uses service role client to bypass RLS — user's session client can only see their own account
  let companyAccountIds: string[] = user.account_id ? [user.account_id] : []
  if (user.role !== 'admin' && user.account_id) {
    try {
      const adminSupabase = await createServiceRoleClient()
      const { data: myAccount } = await adminSupabase
        .from('accounts')
        .select('name')
        .eq('id', user.account_id)
        .maybeSingle()
      if (myAccount?.name) {
        const baseName = myAccount.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
        const { data: allAccounts } = await adminSupabase
          .from('accounts')
          .select('id, name')
          .eq('is_active', true)
        if (allAccounts) {
          const matches = allAccounts.filter(a => a.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim() === baseName)
          companyAccountIds = matches.map(a => a.id)
          console.log(`[SIBLING] user=${user.email} baseName="${baseName}" found=${matches.length} ids=${JSON.stringify(companyAccountIds)}`)
        }
      }
    } catch (err) {
      console.error('[SIBLING ERROR]', err instanceof Error ? err.message : err)
    }
  }

  // Fetch pending reply count (scoped for non-admins)
  let pendingQuery = supabase
    .from('ai_replies')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending_approval')
  if (user.role !== 'admin' && companyAccountIds.length > 0) {
    pendingQuery = pendingQuery.in('account_id', companyAccountIds)
  }
  const { count: pendingCount } = await pendingQuery

  return (
    <DashboardShell user={user} pendingCount={pendingCount ?? 0} companyAccountIds={companyAccountIds}>
      {children}
    </DashboardShell>
  )
}
