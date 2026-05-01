/**
 * POST /api/admin/notifications/test-slack
 *
 * Sends a one-off test message to a Slack Incoming Webhook URL so an admin
 * can verify the webhook is wired up correctly before saving the rule.
 *
 * Auth: any authenticated company_admin / super_admin. Plain members are
 * rejected — this endpoint can post arbitrary text to any URL the caller
 * supplies, so we keep it admin-only to avoid making it an open relay.
 *
 * Body:  { webhook_url: string }
 * Reply: { ok: true } on 2xx Slack response
 *        { ok: false, error: string } on validation / delivery failure
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin } from '@/lib/auth'
import { sendSlackNotification, buildSlackPayload } from '@/lib/notification-service'

interface TestBody {
  webhook_url?: unknown
}

const SLACK_URL_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9/]+/i

export async function POST(request: Request) {
  // ── Auth gate ────────────────────────────────────────────────────
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const profile = await getCurrentUser(user.id)
  if (!isCompanyAdmin(profile?.role)) {
    return NextResponse.json({ ok: false, error: 'Admin only' }, { status: 403 })
  }

  // ── Body validation ──────────────────────────────────────────────
  let body: TestBody
  try {
    body = (await request.json()) as TestBody
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const webhookUrl = typeof body.webhook_url === 'string' ? body.webhook_url.trim() : ''
  if (!webhookUrl) {
    return NextResponse.json({ ok: false, error: 'webhook_url is required' }, { status: 400 })
  }
  if (!SLACK_URL_PATTERN.test(webhookUrl)) {
    return NextResponse.json(
      { ok: false, error: 'webhook_url must be a Slack Incoming Webhook (https://hooks.slack.com/services/...)' },
      { status: 400 },
    )
  }

  // ── Send the test ────────────────────────────────────────────────
  const payload = buildSlackPayload({
    channelLabel: 'Test',
    priority: 'INFO',
    accountName: 'Unified Communications Portal',
    senderName: profile?.full_name || profile?.email || 'Portal Admin',
    senderEmail: profile?.email ?? null,
    subject: 'Test notification',
    preview: 'This is a test notification from your Unified Communications Portal',
    conversationUrl: process.env.NEXT_PUBLIC_SITE_URL || 'https://unified-comm-portal.vercel.app',
  })

  const ok = await sendSlackNotification(webhookUrl, payload, {
    user_id: user.id,
    test: true,
  })

  if (!ok) {
    return NextResponse.json(
      { ok: false, error: 'Slack rejected the test message. Check the webhook URL and try again.' },
      { status: 502 },
    )
  }

  return NextResponse.json({ ok: true })
}
