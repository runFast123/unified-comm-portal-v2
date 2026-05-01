import { redirect } from 'next/navigation'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import { KNOWN_SCOPES } from '@/lib/api-tokens'
import { ApiTokensClient, type TokenRow } from './api-tokens-client'

// Force dynamic — last_used_at refreshes per token use; this page must
// reflect live data on each visit.
export const dynamic = 'force-dynamic'

/**
 * Per-company API tokens page. Visible to admin / company_admin / super_admin
 * (matches the admin nav gate). Non-admins are redirected to the dashboard.
 *
 * super_admin without a company_id sees an empty list — they're expected to
 * pick a company from the companies admin first.
 */
export default async function ApiTokensAdminPage() {
  const supabase = await createServerSupabaseClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()
  if (!authUser) redirect('/login')

  const profile = await getCurrentUser(authUser.id)
  if (!isSuperAdmin(profile?.role) && !isCompanyAdmin(profile?.role)) {
    redirect('/dashboard')
  }

  const admin = await createServiceRoleClient()

  let query = admin
    .from('api_tokens')
    .select('id, company_id, name, prefix, scopes, created_at, last_used_at, revoked_at, expires_at')
    .order('created_at', { ascending: false })

  if (!isSuperAdmin(profile!.role) && profile?.company_id) {
    query = query.eq('company_id', profile.company_id)
  } else if (!isSuperAdmin(profile!.role)) {
    // Non-super admin with no company → show empty list.
    return (
      <ApiTokensClient
        initialTokens={[]}
        knownScopes={[...KNOWN_SCOPES]}
        canCreate={false}
      />
    )
  }

  const { data } = await query
  const tokens = ((data ?? []) as TokenRow[]).map((t) => ({ ...t }))

  return (
    <ApiTokensClient
      initialTokens={tokens}
      knownScopes={[...KNOWN_SCOPES]}
      canCreate={true}
    />
  )
}
