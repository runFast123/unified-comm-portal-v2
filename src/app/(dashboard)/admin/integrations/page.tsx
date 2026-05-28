import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import IntegrationsClient from './integrations-client'

export const dynamic = 'force-dynamic'

/**
 * Admin → Integrations (server wrapper).
 *
 * Resolves the active company server-side so the client can render an
 * unambiguous "Editing for company: X" banner without an extra round-trip.
 *
 *   - super_admin → cookie-selected company (switcher), fall back to home
 *   - company_admin → their home company (cookie is ignored)
 *
 * Integrations themselves are PER-COMPANY (migration 20260528170000).
 * RLS at the table level + the API gate in
 * `src/app/api/integrations/route.ts` are the authoritative scope check;
 * this page just gates UI access + provides display context.
 *
 * Layout-level role gate lives at `./layout.tsx`.
 */
export default async function IntegrationsPage() {
  const supabase = await createServerSupabaseClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()
  if (!authUser) redirect('/login')

  const profile = await getCurrentUser(authUser.id)
  if (!isSuperAdmin(profile?.role) && !isCompanyAdmin(profile?.role)) {
    redirect('/dashboard')
  }

  const homeCompanyId = (profile?.company_id as string | null) ?? null
  const canSwitchCompany = isSuperAdmin(profile?.role)

  // Resolve active company id. Super_admin pulls from the switcher cookie;
  // company_admin is pinned to their home company.
  let activeCompanyId: string | null
  if (canSwitchCompany) {
    const cookieStore = await cookies()
    activeCompanyId = (cookieStore.get('selected_company_id')?.value ?? null) || homeCompanyId
  } else {
    activeCompanyId = homeCompanyId
  }

  // Resolve display name. Best-effort — falls back to a generic label if
  // the lookup fails (rare; the company would have to have been deleted
  // mid-session).
  let activeCompanyName: string | null = null
  if (activeCompanyId) {
    try {
      const admin = await createServiceRoleClient()
      const { data } = await admin
        .from('companies')
        .select('name')
        .eq('id', activeCompanyId)
        .maybeSingle()
      activeCompanyName = (data?.name as string | undefined) ?? null
    } catch { /* non-fatal */ }
  }

  return (
    <IntegrationsClient
      activeCompanyId={activeCompanyId}
      activeCompanyName={activeCompanyName}
      canSwitchCompany={canSwitchCompany}
    />
  )
}
