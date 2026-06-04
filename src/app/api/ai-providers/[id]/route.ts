/**
 * PATCH / DELETE /api/ai-providers/:id
 *
 * Admin / company-admin only (mirrors `/api/company-tags/[id]`). Scoped to the
 * caller's own company unless they are super_admin — the target row's
 * company_id MUST match the caller, else 403/404.
 *
 *   PATCH  → update name / provider_key / base_url / api_key / model /
 *            max_tokens / temperature / is_active. `api_key` is ONLY changed
 *            when a non-empty value is supplied — a PATCH that omits it (or
 *            sends ''/null) NEVER wipes the stored key. Setting is_active=true
 *            deactivates the company's other rows first (partial unique index).
 *   DELETE → hard-delete the row.
 *
 * SECURITY: responses mask the key (has_api_key + api_key_masked), never the
 * raw value. api_key is stored plaintext (matches the legacy ai_config table).
 */

import { NextResponse } from 'next/server'

import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireCompanyAdmin } from '@/lib/tenant-guard'
import { getPreset } from '@/lib/ai-providers'
import { validateProviderBaseUrl } from '@/lib/ssrf'

const MAX_NAME_LEN = 80
const MAX_URL_LEN = 2048
const MAX_MODEL_LEN = 256
const MAX_MAX_TOKENS = 1_000_000

const SELECT_COLUMNS =
  'id, company_id, name, provider_key, base_url, model, max_tokens, temperature, is_active, created_by, created_at, updated_at'
const SELECT_COLUMNS_WITH_KEY = `${SELECT_COLUMNS}, api_key`

interface PatchBody {
  name?: unknown
  provider_key?: unknown
  base_url?: unknown
  api_key?: unknown
  model?: unknown
  max_tokens?: unknown
  temperature?: unknown
  is_active?: unknown
}

type RawRow = {
  api_key?: string | null
  [k: string]: unknown
}

/** Strip api_key from a row and replace it with masked, client-safe fields. */
function maskRow(row: RawRow): Record<string, unknown> {
  const { api_key, ...rest } = row
  const key = typeof api_key === 'string' ? api_key : ''
  const last4 = key.length >= 4 ? key.slice(-4) : key
  return {
    ...rest,
    has_api_key: key.length > 0,
    api_key_masked: key.length > 0 ? `••••${last4}` : null,
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { ctx } = gate
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  let body: PatchBody
  try {
    body = (await request.json()) as PatchBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()

  // Load the target row and verify it belongs to the caller's company. Anyone
  // but a super_admin is pinned to their own company → 403 on mismatch.
  const { data: existing } = await admin
    .from('ai_providers')
    .select('id, company_id')
    .eq('id', id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  if (!ctx.isSuperAdmin && (existing as { company_id: string }).company_id !== ctx.companyId) {
    return NextResponse.json({ error: 'Forbidden: company scope mismatch' }, { status: 403 })
  }
  const targetCompanyId = (existing as { company_id: string }).company_id

  const patch: Record<string, unknown> = {}

  if ('name' in body) {
    if (typeof body.name !== 'string') {
      return NextResponse.json({ error: 'name must be a string' }, { status: 400 })
    }
    const trimmed = body.name.trim()
    if (!trimmed) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    if (trimmed.length > MAX_NAME_LEN) {
      return NextResponse.json({ error: `name must be <= ${MAX_NAME_LEN} chars` }, { status: 400 })
    }
    patch.name = trimmed
  }

  if ('provider_key' in body) {
    if (body.provider_key === null || body.provider_key === '') {
      patch.provider_key = null
    } else if (typeof body.provider_key === 'string') {
      if (!getPreset(body.provider_key)) {
        return NextResponse.json({ error: 'Unknown provider_key' }, { status: 400 })
      }
      patch.provider_key = body.provider_key
    } else {
      return NextResponse.json({ error: 'provider_key must be a string or null' }, { status: 400 })
    }
  }

  if ('base_url' in body) {
    if (typeof body.base_url !== 'string') {
      return NextResponse.json({ error: 'base_url must be a string' }, { status: 400 })
    }
    const trimmed = body.base_url.trim()
    if (!trimmed) return NextResponse.json({ error: 'base_url cannot be empty' }, { status: 400 })
    if (trimmed.length > MAX_URL_LEN) {
      return NextResponse.json({ error: `base_url must be <= ${MAX_URL_LEN} chars` }, { status: 400 })
    }
    // SSRF guard: stored base_url is fetched server-side by callAI later.
    const baseUrlErr = await validateProviderBaseUrl(trimmed)
    if (baseUrlErr) return NextResponse.json({ error: baseUrlErr }, { status: 400 })
    patch.base_url = trimmed
  }

  // api_key is ONLY updated when a non-empty value is supplied. Omitting it, or
  // sending ''/null, preserves the stored key — a PATCH never wipes it.
  if ('api_key' in body && typeof body.api_key === 'string' && body.api_key.trim()) {
    patch.api_key = body.api_key.trim()
  }

  if ('model' in body) {
    if (typeof body.model !== 'string') {
      return NextResponse.json({ error: 'model must be a string' }, { status: 400 })
    }
    const trimmed = body.model.trim()
    if (!trimmed) return NextResponse.json({ error: 'model cannot be empty' }, { status: 400 })
    if (trimmed.length > MAX_MODEL_LEN) {
      return NextResponse.json({ error: `model must be <= ${MAX_MODEL_LEN} chars` }, { status: 400 })
    }
    patch.model = trimmed
  }

  if ('max_tokens' in body) {
    const n = Number(body.max_tokens)
    if (!Number.isInteger(n) || n < 1 || n > MAX_MAX_TOKENS) {
      return NextResponse.json(
        { error: `max_tokens must be an integer between 1 and ${MAX_MAX_TOKENS}` },
        { status: 400 },
      )
    }
    patch.max_tokens = n
  }

  if ('temperature' in body) {
    const n = Number(body.temperature)
    if (!Number.isFinite(n) || n < 0 || n > 2) {
      return NextResponse.json(
        { error: 'temperature must be a number between 0 and 2' },
        { status: 400 },
      )
    }
    patch.temperature = n
  }

  let activating = false
  if ('is_active' in body) {
    if (typeof body.is_active !== 'boolean') {
      return NextResponse.json({ error: 'is_active must be a boolean' }, { status: 400 })
    }
    patch.is_active = body.is_active
    activating = body.is_active === true
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  // If we're activating this row, deactivate the company's OTHER active rows
  // first so the partial unique index (one active per company) is satisfied.
  if (activating) {
    const { error: deactErr } = await admin
      .from('ai_providers')
      .update({ is_active: false })
      .eq('company_id', targetCompanyId)
      .eq('is_active', true)
      .neq('id', id)
    if (deactErr) return NextResponse.json({ error: deactErr.message }, { status: 500 })
  }

  const { data: updated, error } = await admin
    .from('ai_providers')
    .update(patch)
    .eq('id', id)
    .select(SELECT_COLUMNS_WITH_KEY)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  try {
    await admin.from('audit_log').insert({
      user_id: ctx.userId,
      company_id: targetCompanyId,
      action: 'ai_provider.updated',
      entity_type: 'ai_provider',
      entity_id: id,
      details: { fields: Object.keys(patch) },
    })
  } catch {
    /* non-critical */
  }

  return NextResponse.json({ provider: maskRow(updated as RawRow) })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { ctx } = gate
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const admin = await createServiceRoleClient()

  const { data: existing } = await admin
    .from('ai_providers')
    .select('id, company_id, name')
    .eq('id', id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  if (!ctx.isSuperAdmin && (existing as { company_id: string }).company_id !== ctx.companyId) {
    return NextResponse.json({ error: 'Forbidden: company scope mismatch' }, { status: 403 })
  }

  const { error } = await admin
    .from('ai_providers')
    .delete()
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  try {
    await admin.from('audit_log').insert({
      user_id: ctx.userId,
      company_id: (existing as { company_id: string }).company_id,
      action: 'ai_provider.deleted',
      entity_type: 'ai_provider',
      entity_id: id,
      details: {
        name: (existing as { name?: string }).name,
        company_id: (existing as { company_id: string }).company_id,
      },
    })
  } catch {
    /* non-critical */
  }

  return NextResponse.json({ success: true })
}
