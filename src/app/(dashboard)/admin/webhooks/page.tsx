import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import { WebhooksClient, type WebhookRow } from './webhooks-client'

export const dynamic = 'force-dynamic'

const KNOWN_EVENTS = [
  'conversation.created',
  'conversation.resolved',
  'message.received',
] as const

export default async function WebhooksAdminPage() {
  const supabase = await createServerSupabaseClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()
  if (!authUser) redirect('/login')

  const profile = await getCurrentUser(authUser.id)
  if (!isSuperAdmin(profile?.role) && !isCompanyAdmin(profile?.role)) {
    redirect('/dashboard')
  }

  const admin = await createServiceRoleClient()

  // webhook_subscriptions is company-keyed (company_id NOT NULL → companies).
  // Resolve the company to scope by:
  //   - super_admin → the switcher cookie's company when set + valid
  //     (combined cross-tenant view when no cookie / stale cookie).
  //   - company_admin / legacy admin → always their own company.
  let scopeCompanyId: string | null = null
  if (isSuperAdmin(profile!.role)) {
    const cookieStore = await cookies()
    const cookieCompanyId = cookieStore.get('selected_company_id')?.value?.trim() || null
    if (cookieCompanyId) {
      // Validate the cookie points at a real company before trusting it; a
      // stale cookie falls through to the combined (all-tenant) view.
      const { data: co } = await admin
        .from('companies')
        .select('id')
        .eq('id', cookieCompanyId)
        .maybeSingle()
      if (co) scopeCompanyId = cookieCompanyId
    }
  } else if (profile?.company_id) {
    scopeCompanyId = profile.company_id
  } else {
    // Non-super admin with no company → show empty list (never leak cross-tenant).
    return (
      <WebhooksClient
        initialWebhooks={[]}
        knownEvents={[...KNOWN_EVENTS]}
        canCreate={false}
      />
    )
  }

  let query = admin
    .from('webhook_subscriptions')
    .select('id, company_id, url, events, is_active, created_at, last_delivery_at, consecutive_failures, secret_rotated_at')
    .order('created_at', { ascending: false })
  if (scopeCompanyId) {
    query = query.eq('company_id', scopeCompanyId)
  }

  const { data } = await query
  const webhooks = ((data ?? []) as WebhookRow[]).map((w) => ({ ...w }))

  return (
    <WebhooksClient
      initialWebhooks={webhooks}
      knownEvents={[...KNOWN_EVENTS]}
      canCreate={true}
    />
  )
}
