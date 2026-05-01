/**
 * Outgoing webhook subscriptions — admin collection.
 *
 *   GET  /api/admin/webhooks  → list
 *   POST /api/admin/webhooks  → create — body { url, events[] }
 *                               Returns the generated `signing_secret` ONCE.
 *                               Subsequent GETs do NOT return signing_secret.
 *
 * The `signing_secret` is generated server-side (32 random bytes → base64url)
 * so customers can't influence its strength. They use it to verify the
 * `X-Webhook-Signature` header on each delivery.
 *
 * Privilege model matches /api/admin/api-tokens — admin / company_admin
 * within their company, super_admin cross-tenant.
 */

import crypto from 'crypto'

import { NextResponse } from 'next/server'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import { validatePublicHttpsUrl } from '@/lib/url-validator'

interface CreateBody {
  url?: unknown
  events?: unknown
  company_id?: unknown
}

const KNOWN_EVENTS = [
  'conversation.created',
  'conversation.resolved',
  'message.received',
] as const

const MAX_EVENTS = 16

function isValidEventName(s: unknown): s is string {
  if (typeof s !== 'string') return false
  return /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(s) && s.length <= 64
}

async function getSession(): Promise<
  | { ok: true; userId: string; role: string; companyId: string | null }
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

  return {
    ok: true,
    userId: user.id,
    role: profile.role || '',
    companyId: profile.company_id ?? null,
  }
}

export async function GET(request: Request) {
  const gate = await getSession()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const url = new URL(request.url)
  const filterCompanyId = url.searchParams.get('company_id')

  const admin = await createServiceRoleClient()
  // signing_secret is intentionally omitted from the list view — it's only
  // returned on creation. If a customer loses it they must rotate.
  let query = admin
    .from('webhook_subscriptions')
    .select('id, company_id, url, events, is_active, created_at, last_delivery_at, consecutive_failures')
    .order('created_at', { ascending: false })

  if (isSuperAdmin(gate.role)) {
    if (filterCompanyId) query = query.eq('company_id', filterCompanyId)
  } else {
    if (!gate.companyId) return NextResponse.json({ webhooks: [] })
    query = query.eq('company_id', gate.companyId)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ webhooks: data ?? [], known_events: KNOWN_EVENTS })
}

export async function POST(request: Request) {
  const gate = await getSession()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: CreateBody
  try {
    body = (await request.json()) as CreateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // FIX: SSRF-resistant validation — requires https://, rejects private IP
  // ranges, internal hostnames, and unresolvable hosts. See url-validator.ts.
  // TODO(dns-rebinding): re-validate the resolved IP at dispatch time.
  if (typeof body.url !== 'string') {
    return NextResponse.json({ error: 'url must be a string' }, { status: 400 })
  }
  const urlCheck = await validatePublicHttpsUrl(body.url)
  if (!urlCheck.ok) {
    return NextResponse.json({ error: urlCheck.error }, { status: 400 })
  }

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

  let companyId: string | null = null
  if (isSuperAdmin(gate.role)) {
    companyId =
      typeof body.company_id === 'string' && body.company_id.trim()
        ? body.company_id.trim()
        : gate.companyId
  } else {
    companyId = gate.companyId
  }
  if (!companyId) {
    return NextResponse.json({ error: 'company_id is required' }, { status: 400 })
  }

  // 32 random bytes → base64url (~43 chars). HMAC-SHA256 secrets only need
  // 32 bytes of entropy; anything bigger is wasted.
  const signingSecret = crypto.randomBytes(32).toString('base64url')

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('webhook_subscriptions')
    .insert({
      company_id: companyId,
      url: body.url as string,
      events,
      signing_secret: signingSecret,
      created_by: gate.userId,
    })
    .select('id, company_id, url, events, is_active, created_at')
    .single()

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'Failed to create webhook' },
      { status: 500 },
    )
  }

  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'webhook.created',
      entity_type: 'webhook_subscription',
      entity_id: data.id,
      details: { url: data.url, events, company_id: companyId },
    })
  } catch {
    /* non-fatal */
  }

  return NextResponse.json(
    {
      webhook: data,
      // Returned ONCE. The UI must display this with a "save it now" warning.
      signing_secret: signingSecret,
    },
    { status: 201 },
  )
}
