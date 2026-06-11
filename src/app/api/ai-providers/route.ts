/**
 * MULTI-PROVIDER AI configuration store.
 *
 *   GET  /api/ai-providers   → list this company's saved AI providers
 *   POST /api/ai-providers   → create one (admin / company-admin only)
 *
 * A company saves MULTIPLE OpenAI-compatible providers (NVIDIA, OpenAI, Groq,
 * OpenRouter, a custom endpoint, …) and activates exactly one. The active row
 * is what `getAIConfig` (src/lib/api-helpers.ts) reads when making AI calls.
 *
 * Auth model mirrors `/api/company-tags` + `/api/macros`: authenticate +
 * resolve role/company via the centralized tenant-guard, then talk to Postgres
 * through the service-role client (RLS is off there, so every query is scoped
 * in TypeScript). super_admin may target another company via `?company_id=`
 * (GET) or the company switcher's `selected_company_id` cookie / an explicit
 * `company_id` in the POST body.
 *
 * SECURITY: `api_key` is encrypted at rest (src/lib/encryption envelope
 * format "v1:<keyId>:…"; pre-encryption plaintext rows are tolerated on
 * read). The raw key is NEVER returned to a client — list responses expose
 * only `has_api_key` + `api_key_masked` ('••••' + last 4 of the plaintext).
 */

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireUser, requireCompanyAdmin } from '@/lib/tenant-guard'
import { getPreset } from '@/lib/ai-providers'
import { validateProviderBaseUrl } from '@/lib/ssrf'
import { encrypt, decrypt, __parseCiphertextKeyId } from '@/lib/encryption'

const MAX_NAME_LEN = 80
const MAX_URL_LEN = 2048
const MAX_MODEL_LEN = 256
// Mirrors getAIConfig's defaults; sane outer bounds so a typo can't persist an
// absurd value that later breaks an upstream call.
const DEFAULT_MAX_TOKENS = 4096
const MAX_MAX_TOKENS = 1_000_000
const DEFAULT_TEMPERATURE = 1.0

// Columns that are safe to read back. NOTE: never select api_key into a
// response shape — only its derived has_api_key / api_key_masked.
const SELECT_COLUMNS =
  'id, company_id, name, provider_key, base_url, model, max_tokens, temperature, is_active, created_by, created_at, updated_at, last_tested_at, last_test_ok, last_test_error'
// Includes api_key so the handler can derive the mask; stripped before responding.
const SELECT_COLUMNS_WITH_KEY = `${SELECT_COLUMNS}, api_key`

interface CreateBody {
  name?: unknown
  provider_key?: unknown
  base_url?: unknown
  api_key?: unknown
  model?: unknown
  max_tokens?: unknown
  temperature?: unknown
  activate?: unknown
  company_id?: unknown
}

type RawRow = {
  api_key?: string | null
  [k: string]: unknown
}

/** Strip api_key from a row and replace it with masked, client-safe fields. */
function maskRow(row: RawRow): Record<string, unknown> {
  const { api_key, ...rest } = row
  const stored = typeof api_key === 'string' ? api_key : ''
  // Stored values are encrypted at rest (v1:…); legacy rows may still hold
  // plaintext. Mask the PLAINTEXT tail either way — an undecryptable
  // ciphertext (key rotated out of the ring) masks with no tail.
  let key = stored
  if (stored && __parseCiphertextKeyId(stored) !== null) {
    try {
      key = decrypt(stored)
    } catch {
      key = ''
    }
  }
  const last4 = key.length >= 4 ? key.slice(-4) : key
  return {
    ...rest,
    has_api_key: stored.length > 0,
    api_key_masked: stored.length > 0 ? (key ? `••••${last4}` : '••••') : null,
  }
}

/**
 * Resolve the company the request targets. super_admin may point at any
 * company via `?company_id=` or the `selected_company_id` cookie; everyone
 * else is pinned to their own `ctx.companyId`.
 */
async function resolveTargetCompanyId(
  request: Request,
  ctx: { companyId: string | null; isSuperAdmin: boolean },
): Promise<string> {
  let targetCompanyId = ctx.companyId || ''
  if (ctx.isSuperAdmin) {
    const url = new URL(request.url)
    const queryCompanyId = url.searchParams.get('company_id')
    if (queryCompanyId) {
      targetCompanyId = queryCompanyId
    } else {
      const cookieStore = await cookies()
      const cookieCompanyId = cookieStore.get('selected_company_id')?.value?.trim() || ''
      targetCompanyId = cookieCompanyId || ctx.companyId || ''
    }
  }
  return targetCompanyId
}

export async function GET(request: Request) {
  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const targetCompanyId = await resolveTargetCompanyId(request, gate.ctx)
  if (!targetCompanyId) return NextResponse.json({ providers: [] })

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('ai_providers')
    .select(SELECT_COLUMNS_WITH_KEY)
    .eq('company_id', targetCompanyId)
    .order('is_active', { ascending: false })
    .order('name', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const providers = (data ?? []).map((r) => maskRow(r as RawRow))
  return NextResponse.json({ providers })
}

export async function POST(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { ctx } = gate

  let body: CreateBody
  try {
    body = (await request.json()) as CreateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Resolve the owning company. super_admin may target another company via an
  // explicit company_id in the body; everyone else is pinned to their own.
  let companyId: string | null = ctx.companyId
  if (ctx.isSuperAdmin && typeof body.company_id === 'string' && body.company_id) {
    companyId = body.company_id
  }
  if (!companyId) {
    return NextResponse.json({ error: 'No company scope' }, { status: 400 })
  }

  // ── Validate the required string fields ──────────────────────────────
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (name.length > MAX_NAME_LEN) {
    return NextResponse.json({ error: `name must be <= ${MAX_NAME_LEN} chars` }, { status: 400 })
  }

  const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : ''
  if (!baseUrl) return NextResponse.json({ error: 'base_url is required' }, { status: 400 })
  if (baseUrl.length > MAX_URL_LEN) {
    return NextResponse.json({ error: `base_url must be <= ${MAX_URL_LEN} chars` }, { status: 400 })
  }
  // SSRF guard: this base_url is later fetched server-side by callAI, so
  // validate it at WRITE time (HTTPS only, no private/loopback/metadata/
  // rebinding) — otherwise a stored URL bypasses the test-time checks.
  const baseUrlErr = await validateProviderBaseUrl(baseUrl)
  if (baseUrlErr) return NextResponse.json({ error: baseUrlErr }, { status: 400 })

  const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
  if (!apiKey) return NextResponse.json({ error: 'api_key is required' }, { status: 400 })

  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return NextResponse.json({ error: 'model is required' }, { status: 400 })
  if (model.length > MAX_MODEL_LEN) {
    return NextResponse.json({ error: `model must be <= ${MAX_MODEL_LEN} chars` }, { status: 400 })
  }

  // ── Optional fields ──────────────────────────────────────────────────
  // provider_key is advisory metadata for the UI; validate against the shared
  // preset catalog when present so we never persist an unknown key.
  let providerKey: string | null = null
  if (body.provider_key !== undefined && body.provider_key !== null && body.provider_key !== '') {
    if (typeof body.provider_key !== 'string') {
      return NextResponse.json({ error: 'provider_key must be a string' }, { status: 400 })
    }
    if (!getPreset(body.provider_key)) {
      return NextResponse.json({ error: 'Unknown provider_key' }, { status: 400 })
    }
    providerKey = body.provider_key
  }

  let maxTokens = DEFAULT_MAX_TOKENS
  if (body.max_tokens !== undefined && body.max_tokens !== null) {
    const n = Number(body.max_tokens)
    if (!Number.isInteger(n) || n < 1 || n > MAX_MAX_TOKENS) {
      return NextResponse.json(
        { error: `max_tokens must be an integer between 1 and ${MAX_MAX_TOKENS}` },
        { status: 400 },
      )
    }
    maxTokens = n
  }

  let temperature = DEFAULT_TEMPERATURE
  if (body.temperature !== undefined && body.temperature !== null) {
    const n = Number(body.temperature)
    if (!Number.isFinite(n) || n < 0 || n > 2) {
      return NextResponse.json(
        { error: 'temperature must be a number between 0 and 2' },
        { status: 400 },
      )
    }
    temperature = n
  }

  if (body.activate !== undefined && typeof body.activate !== 'boolean') {
    return NextResponse.json({ error: 'activate must be a boolean' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()

  // Auto-activate when explicitly requested OR when this is the company's FIRST
  // provider (so a brand-new company immediately has a working active row).
  const { count: existingCount, error: countErr } = await admin
    .from('ai_providers')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
  if (countErr) return NextResponse.json({ error: countErr.message }, { status: 500 })

  const isFirst = (existingCount ?? 0) === 0
  const activate = body.activate === true || isFirst

  // Encrypt BEFORE the deactivation write below: encrypt() throws when the
  // encryption key env is unset, and throwing after deactivating the other
  // rows would leave the company with NO active provider.
  let encryptedKey: string
  try {
    encryptedKey = encrypt(apiKey)
  } catch {
    return NextResponse.json(
      { error: 'Server encryption key is not configured — cannot store credentials. Set CHANNEL_CONFIG_ENCRYPTION_KEY.' },
      { status: 500 }
    )
  }

  // Honor the partial unique index (one active row per company): deactivate the
  // company's other rows BEFORE inserting an active one.
  if (activate) {
    const { error: deactErr } = await admin
      .from('ai_providers')
      .update({ is_active: false })
      .eq('company_id', companyId)
      .eq('is_active', true)
    if (deactErr) return NextResponse.json({ error: deactErr.message }, { status: 500 })
  }

  const { data: inserted, error } = await admin
    .from('ai_providers')
    .insert({
      company_id: companyId,
      name,
      provider_key: providerKey,
      base_url: baseUrl,
      api_key: encryptedKey,
      model,
      max_tokens: maxTokens,
      temperature,
      is_active: activate,
      created_by: ctx.userId,
    })
    .select(SELECT_COLUMNS_WITH_KEY)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  try {
    await admin.from('audit_log').insert({
      user_id: ctx.userId,
      company_id: companyId,
      action: 'ai_provider.created',
      entity_type: 'ai_provider',
      entity_id: (inserted as { id: string }).id,
      details: { name, provider_key: providerKey, is_active: activate, company_id: companyId },
    })
  } catch {
    /* non-critical */
  }

  return NextResponse.json({ provider: maskRow(inserted as RawRow) }, { status: 201 })
}
