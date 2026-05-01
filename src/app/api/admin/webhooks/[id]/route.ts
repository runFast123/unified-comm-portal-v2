/**
 * Per-subscription admin operations.
 *
 *   PATCH  /api/admin/webhooks/[id] → update url / events / is_active
 *   DELETE /api/admin/webhooks/[id] → permanently delete (cascades deliveries)
 *
 * Privilege model matches the collection endpoint: super_admin cross-tenant,
 * company_admin within own company.
 */

import { NextResponse } from 'next/server'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import { validatePublicHttpsUrl } from '@/lib/url-validator'

interface PatchBody {
  url?: unknown
  events?: unknown
  is_active?: unknown
}

const MAX_EVENTS = 16

function isValidEventName(s: unknown): s is string {
  if (typeof s !== 'string') return false
  return /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(s) && s.length <= 64
}

async function getSessionAndSub(id: string): Promise<
  | {
      ok: true
      userId: string
      role: string
      companyId: string | null
      sub: { id: string; company_id: string; url: string; events: string[]; is_active: boolean }
    }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }

  const profile = await getCurrentUser(user.id)
  if (!profile) return { ok: false, status: 403, error: 'No profile found' }
  if (!isSuperAdmin(profile.role) && !isCompanyAdmin(profile.role)) {
    return { ok: false, status: 403, error: 'Admin only' }
  }

  const admin = await createServiceRoleClient()
  const { data: sub } = await admin
    .from('webhook_subscriptions')
    .select('id, company_id, url, events, is_active')
    .eq('id', id)
    .maybeSingle()
  if (!sub) return { ok: false, status: 404, error: 'Webhook not found' }

  if (!isSuperAdmin(profile.role) && sub.company_id !== profile.company_id) {
    return { ok: false, status: 403, error: 'Webhook belongs to another company' }
  }

  return {
    ok: true,
    userId: user.id,
    role: profile.role || '',
    companyId: profile.company_id ?? null,
    sub: sub as { id: string; company_id: string; url: string; events: string[]; is_active: boolean },
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const gate = await getSessionAndSub(id)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: PatchBody
  try {
    body = (await request.json()) as PatchBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const update: Record<string, unknown> = {}

  if (body.url !== undefined) {
    // FIX: SSRF-resistant validation — same rules as POST. See url-validator.ts.
    // TODO(dns-rebinding): re-validate the resolved IP at dispatch time.
    if (typeof body.url !== 'string') {
      return NextResponse.json({ error: 'url must be a string' }, { status: 400 })
    }
    const urlCheck = await validatePublicHttpsUrl(body.url)
    if (!urlCheck.ok) {
      return NextResponse.json({ error: urlCheck.error }, { status: 400 })
    }
    update.url = body.url
  }

  if (body.events !== undefined) {
    if (!Array.isArray(body.events) || body.events.length === 0) {
      return NextResponse.json({ error: 'events must be a non-empty array' }, { status: 400 })
    }
    if (body.events.length > MAX_EVENTS) {
      return NextResponse.json({ error: `Too many events (max ${MAX_EVENTS})` }, { status: 400 })
    }
    const events: string[] = []
    for (const e of body.events) {
      if (!isValidEventName(e)) {
        return NextResponse.json({ error: `Invalid event name: ${e}` }, { status: 400 })
      }
      if (!events.includes(e)) events.push(e)
    }
    update.events = events
  }

  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') {
      return NextResponse.json({ error: 'is_active must be a boolean' }, { status: 400 })
    }
    update.is_active = body.is_active
    // Re-activating a previously failing sub clears the failure counter so
    // it gets a fresh shot before being auto-disabled again.
    if (body.is_active) update.consecutive_failures = 0
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('webhook_subscriptions')
    .update(update)
    .eq('id', id)
    .select('id, company_id, url, events, is_active, created_at, last_delivery_at, consecutive_failures')
    .single()
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Update failed' }, { status: 500 })
  }

  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'webhook.updated',
      entity_type: 'webhook_subscription',
      entity_id: id,
      details: { changes: Object.keys(update) },
    })
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({ webhook: data })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const gate = await getSessionAndSub(id)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = await createServiceRoleClient()
  const { error } = await admin.from('webhook_subscriptions').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'webhook.deleted',
      entity_type: 'webhook_subscription',
      entity_id: id,
      details: { url: gate.sub.url, company_id: gate.sub.company_id },
    })
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({ success: true })
}
