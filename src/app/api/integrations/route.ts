import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import {
  getIntegrationStatus,
  saveIntegration,
  deleteIntegration,
  type IntegrationKey,
} from '@/lib/integration-settings'
import { getRequestId } from '@/lib/request-id'
import { logError } from '@/lib/logger'

export const dynamic = 'force-dynamic'

type Gate =
  | { ok: true; userId: string; companyId: string }
  | { ok: false; status: number; error: string }

/**
 * Admin gate. The integrations table holds OAuth client credentials and
 * is now PER-COMPANY (see migration 20260528170000) — each tenant
 * configures its own Google/Azure OAuth client and one tenant's
 * misconfiguration can't break sign-in for another.
 *
 *   - super_admin: scope = the cookie-selected company (switcher), or
 *     their own company if no cookie is set. We refuse to proceed
 *     without a resolved company because every row MUST have a
 *     company_id.
 *   - company_admin: scope = their own company. They cannot read or
 *     mutate any other tenant's row (RLS would also block it, but we
 *     fail fast here for clearer errors).
 *
 * The matching UI layout at
 * `src/app/(dashboard)/admin/integrations/layout.tsx` enforces an
 * equivalent gate at the page level.
 */
async function requireIntegrationsAdmin(): Promise<Gate> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role, company_id')
    .eq('id', user.id)
    .maybeSingle()
  const role = profile?.role ?? null
  const homeCompanyId = (profile?.company_id as string | null) ?? null

  if (!isSuperAdmin(role) && !isCompanyAdmin(role)) {
    return { ok: false, status: 403, error: 'Admin only' }
  }

  // Resolve scope. super_admin can pick a tenant via the switcher cookie;
  // company_admin is pinned to their home company regardless of cookie.
  let companyId: string | null
  if (isSuperAdmin(role)) {
    const cookieStore = await cookies()
    const cookieCompanyId = cookieStore.get('selected_company_id')?.value ?? null
    companyId = cookieCompanyId || homeCompanyId
  } else {
    companyId = homeCompanyId
  }

  if (!companyId) {
    return {
      ok: false,
      status: 400,
      error:
        'No active company selected — pick a tenant in the company switcher before managing integrations.',
    }
  }
  return { ok: true, userId: user.id, companyId }
}

function isIntegrationKey(v: unknown): v is IntegrationKey {
  return v === 'google_oauth' || v === 'azure_oauth'
}

function requireNonEmptyString(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${label} is required`)
  }
  return v.trim()
}

function validateConfig(
  key: IntegrationKey,
  raw: unknown
): Record<string, string> {
  if (!raw || typeof raw !== 'object') {
    throw new Error('config must be an object')
  }
  const r = raw as Record<string, unknown>
  if (key === 'google_oauth') {
    return {
      client_id: requireNonEmptyString(r.client_id, 'client_id'),
      client_secret: requireNonEmptyString(r.client_secret, 'client_secret'),
    }
  }
  // azure_oauth
  return {
    tenant_id: requireNonEmptyString(r.tenant_id, 'tenant_id'),
    client_id: requireNonEmptyString(r.client_id, 'client_id'),
    client_secret: requireNonEmptyString(r.client_secret, 'client_secret'),
  }
}

// ─── GET — list statuses (never includes secrets) ────────────────────

export async function GET() {
  const requestId = await getRequestId()
  const gate = await requireIntegrationsAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error, request_id: requestId }, { status: gate.status })

  try {
    const [google, azure] = await Promise.all([
      getIntegrationStatus('google_oauth', gate.companyId),
      getIntegrationStatus('azure_oauth', gate.companyId),
    ])
    return NextResponse.json({
      google_oauth: google,
      azure_oauth: azure,
      // Echo the scope back so the client can render "Editing for company: X"
      // and detect a mid-session switch.
      company_id: gate.companyId,
    })
  } catch (err) {
    logError('system', 'integrations_get_error', err instanceof Error ? err.message : 'Internal error', {
      request_id: requestId,
      user_id: gate.userId,
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error', request_id: requestId },
      { status: 500 }
    )
  }
}

// ─── POST — save/upsert a config ────────────────────────────────────

export async function POST(request: Request) {
  const requestId = await getRequestId()
  const gate = await requireIntegrationsAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error, request_id: requestId }, { status: gate.status })

  try {
    const body = (await request.json()) as { key?: unknown; config?: unknown }
    if (!isIntegrationKey(body.key)) {
      return NextResponse.json(
        { error: 'key must be google_oauth or azure_oauth', request_id: requestId },
        { status: 400 }
      )
    }
    let validated: Record<string, string>
    try {
      validated = validateConfig(body.key, body.config)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid config', request_id: requestId },
        { status: 400 }
      )
    }

    await saveIntegration(body.key, validated, gate.userId, gate.companyId)

    // Audit log — DO NOT log the secret. request_id stays in details so we
    // can correlate the audit row with the same request in stdout/Sentry.
    const admin = await createServiceRoleClient()
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'integration.save',
      entity_type: 'integration',
      entity_id: null,
      details: {
        key: body.key,
        company_id: gate.companyId,
        client_id_last4:
          typeof validated.client_id === 'string' ? validated.client_id.slice(-4) : null,
        request_id: requestId,
      },
    })

    return NextResponse.json({ success: true, request_id: requestId })
  } catch (err) {
    logError('system', 'integrations_save_error', err instanceof Error ? err.message : 'Internal error', {
      request_id: requestId,
      user_id: gate.userId,
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error', request_id: requestId },
      { status: 500 }
    )
  }
}

// ─── DELETE — remove a saved config (falls back to env) ─────────────

export async function DELETE(request: Request) {
  const requestId = await getRequestId()
  const gate = await requireIntegrationsAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error, request_id: requestId }, { status: gate.status })

  const url = new URL(request.url)
  const key = url.searchParams.get('key')
  if (!isIntegrationKey(key)) {
    return NextResponse.json(
      { error: 'key query param must be google_oauth or azure_oauth', request_id: requestId },
      { status: 400 }
    )
  }

  try {
    await deleteIntegration(key, gate.companyId)
    const admin = await createServiceRoleClient()
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'integration.delete',
      entity_type: 'integration',
      entity_id: null,
      details: { key, company_id: gate.companyId, request_id: requestId },
    })
    return NextResponse.json({ success: true, request_id: requestId })
  } catch (err) {
    logError('system', 'integrations_delete_error', err instanceof Error ? err.message : 'Internal error', {
      request_id: requestId,
      user_id: gate.userId,
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error', request_id: requestId },
      { status: 500 }
    )
  }
}
