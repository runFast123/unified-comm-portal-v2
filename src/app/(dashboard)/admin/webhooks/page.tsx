import { redirect } from 'next/navigation'
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
  let query = admin
    .from('webhook_subscriptions')
    .select('id, company_id, url, events, is_active, created_at, last_delivery_at, consecutive_failures')
    .order('created_at', { ascending: false })
  if (!isSuperAdmin(profile!.role) && profile?.company_id) {
    query = query.eq('company_id', profile.company_id)
  } else if (!isSuperAdmin(profile!.role)) {
    return (
      <WebhooksClient
        initialWebhooks={[]}
        knownEvents={[...KNOWN_EVENTS]}
        canCreate={false}
      />
    )
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
