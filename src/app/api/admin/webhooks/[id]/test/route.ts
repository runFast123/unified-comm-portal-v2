/**
 * POST /api/admin/webhooks/[id]/test
 *
 * Fires a synthetic `webhook.test` event at the subscription so admins can
 * verify the customer's endpoint handles deliveries before relying on real
 * conversation events. Returns immediately with `{ queued: true }` and lets
 * the dispatcher run after the response (so a slow customer endpoint doesn't
 * block the click).
 *
 * The subscription must include `webhook.test` in its events array OR be
 * subscribed to any of the canonical events — the dispatcher itself filters
 * by event_type. We bypass that here by calling dispatchToSubscription
 * directly via the test export, so admins can fire a test even when the
 * sub didn't subscribe to webhook.test explicitly.
 */

import { NextResponse } from 'next/server'
import { after } from 'next/server'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import { __test as webhookTest } from '@/lib/webhook-dispatcher'

export async function POST(
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
  const { data: sub } = await admin
    .from('webhook_subscriptions')
    .select('id, company_id, url, events, signing_secret, is_active, consecutive_failures')
    .eq('id', id)
    .maybeSingle()
  if (!sub) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  if (!isSuperAdmin(profile.role) && sub.company_id !== profile.company_id) {
    return NextResponse.json({ error: 'Webhook belongs to another company' }, { status: 403 })
  }

  // Fire-and-forget after the response. The dispatcher records the attempt
  // in webhook_deliveries so the UI can surface the result on next poll.
  const subRow = sub as {
    id: string
    company_id: string
    url: string
    events: string[]
    signing_secret: string
    is_active: boolean
    consecutive_failures: number
  }

  after(() =>
    webhookTest
      .dispatchToSubscription(
        subRow,
        'webhook.test',
        {
          message: 'This is a test event from Unified Comms Portal.',
          fired_by: { user_id: user.id, email: profile.email },
          fired_at: new Date().toISOString(),
        },
        {},
      )
      .catch(() => {
        /* dispatcher already logs internally; nothing to do here */
      }),
  )

  return NextResponse.json({ queued: true })
}
