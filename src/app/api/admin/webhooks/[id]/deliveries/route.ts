/**
 * GET /api/admin/webhooks/[id]/deliveries
 *
 * Returns the most recent 50 delivery attempts for a subscription so admins
 * can debug failed customer endpoints. Privilege-checked the same way as
 * the parent subscription endpoints.
 */

import { NextResponse } from 'next/server'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

const LIMIT = 50

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const profile = await getCurrentUser(user.id)
  if (!profile) return NextResponse.json({ error: 'No profile found' }, { status: 403 })
  if (!isSuperAdmin(profile.role) && !isCompanyAdmin(profile.role)) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const admin = await createServiceRoleClient()

  // Subscription scope check before reading deliveries.
  const { data: sub } = await admin
    .from('webhook_subscriptions')
    .select('id, company_id')
    .eq('id', id)
    .maybeSingle()
  if (!sub) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  if (!isSuperAdmin(profile.role) && sub.company_id !== profile.company_id) {
    return NextResponse.json({ error: 'Webhook belongs to another company' }, { status: 403 })
  }

  const { data, error } = await admin
    .from('webhook_deliveries')
    .select('id, event_type, http_status, attempted_at, duration_ms, error, retry_count, payload_excerpt')
    .eq('subscription_id', id)
    .order('attempted_at', { ascending: false })
    .limit(LIMIT)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ deliveries: data ?? [] })
}
