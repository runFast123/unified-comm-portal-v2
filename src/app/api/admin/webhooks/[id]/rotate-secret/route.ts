/**
 * POST /api/admin/webhooks/[id]/rotate-secret
 *
 * Generates a NEW signing secret for the subscription, moves the current
 * `signing_secret` into `previous_secret`, and stamps `secret_rotated_at`.
 *
 * The new secret is returned ONCE in the response. After that, neither
 * GET /api/admin/webhooks nor any other read path will return it again —
 * the customer must rotate again if they lose it.
 *
 * Grace period semantics:
 *   * The dispatcher signs outgoing payloads with the NEW `signing_secret`
 *     from the moment rotation lands. Our outgoing signatures never use
 *     `previous_secret` — that field exists solely so the customer can keep
 *     verifying recently-rotated payloads against the OLD secret on their
 *     side during the cutover window (24h, conventionally).
 *   * Each subsequent rotation overwrites `previous_secret`, so the grace
 *     window collapses if you rotate twice in a row.
 *
 * Privilege model matches the rest of /api/admin/webhooks — super_admin
 * cross-tenant, company_admin within their own company.
 */

import crypto from 'crypto'

import { NextResponse } from 'next/server'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

/** Grace window we promise the admin in the response (ms). 24h. */
const GRACE_WINDOW_MS = 24 * 60 * 60 * 1000

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
    .select('id, company_id, url, signing_secret')
    .eq('id', id)
    .maybeSingle()
  if (!sub) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

  // Explicit company scoping in addition to RLS — defense in depth so a
  // super_admin can't accidentally rotate a tenant's secret via a stale
  // session, and a company_admin's request is double-checked here.
  if (!isSuperAdmin(profile.role) && sub.company_id !== profile.company_id) {
    return NextResponse.json({ error: 'Webhook belongs to another company' }, { status: 403 })
  }

  // 32 random bytes → base64url. Same entropy + encoding as creation path
  // in POST /api/admin/webhooks — customer-side verification code that
  // worked for the original secret will work for the rotated one.
  const newSecret = crypto.randomBytes(32).toString('base64url')
  const rotatedAt = new Date()

  const subRow = sub as { id: string; company_id: string; url: string; signing_secret: string }

  const { error: updateErr } = await admin
    .from('webhook_subscriptions')
    .update({
      signing_secret: newSecret,
      previous_secret: subRow.signing_secret,
      secret_rotated_at: rotatedAt.toISOString(),
    })
    .eq('id', id)

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  try {
    await admin.from('audit_log').insert({
      user_id: user.id,
      action: 'webhook.secret_rotated',
      entity_type: 'webhook_subscription',
      entity_id: id,
      details: {
        url: subRow.url,
        company_id: subRow.company_id,
        rotated_at: rotatedAt.toISOString(),
      },
    })
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({
    // Returned ONCE. The UI shows it in a one-time copy-to-clipboard modal
    // and we never expose it again on subsequent reads.
    new_secret: newSecret,
    rotated_at: rotatedAt.toISOString(),
    previous_valid_until: new Date(rotatedAt.getTime() + GRACE_WINDOW_MS).toISOString(),
  })
}
