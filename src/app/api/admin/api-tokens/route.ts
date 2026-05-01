/**
 * Per-company API tokens — admin collection endpoint.
 *
 *   GET  /api/admin/api-tokens   → list (returns prefix only, never plaintext)
 *   POST /api/admin/api-tokens   → create — body { name, scopes[], expires_at? }
 *                                  Returns plaintext token EXACTLY ONCE.
 *
 * Privilege model:
 *   - super_admin can manage tokens on any company (must pass company_id in body).
 *   - admin / company_admin manage tokens scoped to their own company.
 *   - everyone else → 403.
 *
 * The DB has matching RLS, but we resolve the caller in TS too so we can
 * scope GET / pin POST.company_id without forcing the caller through SET LOCAL
 * shenanigans.
 */

import { NextResponse } from 'next/server'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import { generateToken, KNOWN_SCOPES } from '@/lib/api-tokens'

interface CreateBody {
  name?: unknown
  scopes?: unknown
  expires_at?: unknown
  company_id?: unknown
}

const MAX_NAME_LEN = 80
const MAX_SCOPES = 16
const SCOPE_PATTERN = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/i

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
  let query = admin
    .from('api_tokens')
    .select('id, company_id, name, prefix, scopes, created_at, last_used_at, revoked_at, expires_at')
    .order('created_at', { ascending: false })

  if (isSuperAdmin(gate.role)) {
    if (filterCompanyId) query = query.eq('company_id', filterCompanyId)
  } else {
    if (!gate.companyId) return NextResponse.json({ tokens: [] })
    query = query.eq('company_id', gate.companyId)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ tokens: data ?? [] })
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

  // Name validation.
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (name.length > MAX_NAME_LEN) {
    return NextResponse.json({ error: `name must be <= ${MAX_NAME_LEN} chars` }, { status: 400 })
  }

  // Scopes validation. Free-form strings but we reject obvious garbage so a
  // typo doesn't quietly create a useless token.
  const scopesRaw = Array.isArray(body.scopes) ? body.scopes : []
  if (scopesRaw.length > MAX_SCOPES) {
    return NextResponse.json({ error: `Too many scopes (max ${MAX_SCOPES})` }, { status: 400 })
  }
  const scopes: string[] = []
  for (const s of scopesRaw) {
    if (typeof s !== 'string') {
      return NextResponse.json({ error: 'scopes must be an array of strings' }, { status: 400 })
    }
    const trimmed = s.trim().toLowerCase()
    if (!SCOPE_PATTERN.test(trimmed)) {
      return NextResponse.json({ error: `Invalid scope format: ${s}` }, { status: 400 })
    }
    if (!scopes.includes(trimmed)) scopes.push(trimmed)
  }

  // Expiry validation.
  let expiresAt: string | null = null
  if (body.expires_at != null && body.expires_at !== '') {
    if (typeof body.expires_at !== 'string') {
      return NextResponse.json({ error: 'expires_at must be an ISO string' }, { status: 400 })
    }
    const t = Date.parse(body.expires_at)
    if (!Number.isFinite(t)) {
      return NextResponse.json({ error: 'expires_at is not a valid date' }, { status: 400 })
    }
    if (t <= Date.now()) {
      return NextResponse.json({ error: 'expires_at must be in the future' }, { status: 400 })
    }
    expiresAt = new Date(t).toISOString()
  }

  // Resolve target company. super_admin may pass company_id in the body;
  // everyone else is pinned to their own company.
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

  const { plaintext, hash, prefix } = generateToken()

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('api_tokens')
    .insert({
      company_id: companyId,
      name,
      token_hash: hash,
      prefix,
      scopes,
      created_by: gate.userId,
      expires_at: expiresAt,
    })
    .select('id, company_id, name, prefix, scopes, created_at, expires_at')
    .single()

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'Failed to create token' },
      { status: 500 },
    )
  }

  // Audit. Plaintext NEVER hits the audit_log.
  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'api_token.created',
      entity_type: 'api_token',
      entity_id: data.id,
      details: { name, prefix, scopes, company_id: companyId, expires_at: expiresAt },
    })
  } catch {
    /* non-fatal */
  }

  return NextResponse.json(
    {
      token: data,
      // Plaintext returned ONCE — the UI is responsible for displaying it
      // with a "save it now" warning. Never leaves this response again.
      plaintext,
      known_scopes: KNOWN_SCOPES,
    },
    { status: 201 },
  )
}
