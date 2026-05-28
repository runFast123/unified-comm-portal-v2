import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isSuperAdmin } from '@/lib/auth'
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
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string }

/**
 * Super_admin-only gate. The integrations table stores PLATFORM-WIDE OAuth
 * client credentials (one Google client + one Azure client for the entire
 * deploy), so allowing any company_admin to read/rotate them would let one
 * tenant break sign-in for everyone else. The matching UI layout at
 * `src/app/(dashboard)/admin/integrations/layout.tsx` enforces the same
 * gate at the page level.
 *
 * TODO(multi-tenant): if we ever make integrations per-tenant (add a
 * company_id column and scope reads/writes), relax this to company_admin
 * of the matching tenant.
 */
async function requireSuperAdmin(): Promise<Gate> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  if (!isSuperAdmin(profile?.role ?? null)) {
    return { ok: false, status: 403, error: 'Super admin only' }
  }
  return { ok: true, userId: user.id }
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
  const gate = await requireSuperAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error, request_id: requestId }, { status: gate.status })

  try {
    const [google, azure] = await Promise.all([
      getIntegrationStatus('google_oauth'),
      getIntegrationStatus('azure_oauth'),
    ])
    return NextResponse.json({ google_oauth: google, azure_oauth: azure })
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
  const gate = await requireSuperAdmin()
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

    await saveIntegration(body.key, validated, gate.userId)

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
  const gate = await requireSuperAdmin()
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
    await deleteIntegration(key)
    const admin = await createServiceRoleClient()
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'integration.delete',
      entity_type: 'integration',
      entity_id: null,
      details: { key, request_id: requestId },
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
