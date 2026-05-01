/**
 * Per-company admin API.
 *
 *   GET   /api/admin/companies/:id  → read (super_admin OR company_admin of that company)
 *   PATCH /api/admin/companies/:id  → update editable fields (same gate)
 *
 * Editable fields:
 *   name, slug, logo_url, accent_color, monthly_ai_budget_usd, settings,
 *   default_email_signature.
 *
 * `default_email_signature` writes are also exposed via
 * `/api/admin/companies/:id/signature` (kept for back-compat / focused signature UI).
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isSuperAdmin, isCompanyAdmin } from '@/lib/auth'

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

interface UpdateBody {
  name?: string
  slug?: string | null
  logo_url?: string | null
  accent_color?: string | null
  monthly_ai_budget_usd?: number | null
  settings?: Record<string, unknown> | null
  default_email_signature?: string | null
}

async function requireCompanyAdminFor(companyId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }

  const profile = await getCurrentUser(user.id)
  if (!profile) return { ok: false as const, status: 403, error: 'Forbidden' }

  if (isSuperAdmin(profile.role)) {
    return { ok: true as const, userId: user.id, isSuper: true as const }
  }
  if (isCompanyAdmin(profile.role) && profile.company_id === companyId) {
    return { ok: true as const, userId: user.id, isSuper: false as const }
  }
  return { ok: false as const, status: 403, error: 'Forbidden' }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const gate = await requireCompanyAdminFor(id)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('companies')
    .select(
      'id, name, slug, logo_url, accent_color, monthly_ai_budget_usd, settings, default_email_signature, created_at, updated_at',
    )
    .eq('id', id)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Company not found' }, { status: 404 })
  return NextResponse.json({ company: data })
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const gate = await requireCompanyAdminFor(id)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: UpdateBody
  try {
    body = (await request.json()) as UpdateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}

  if (body.name !== undefined) {
    const trimmed = String(body.name).trim()
    if (!trimmed || trimmed.length > 200) {
      return NextResponse.json({ error: 'name must be 1-200 chars' }, { status: 400 })
    }
    patch.name = trimmed
  }

  if (body.slug !== undefined) {
    if (body.slug === null || body.slug === '') {
      patch.slug = null
    } else {
      const candidate = String(body.slug).trim().toLowerCase()
      if (!SLUG_PATTERN.test(candidate)) {
        return NextResponse.json(
          { error: 'slug must be 1-64 chars of lowercase letters, digits, or dashes' },
          { status: 400 },
        )
      }
      patch.slug = candidate
    }
  }

  if (body.logo_url !== undefined) {
    if (body.logo_url === null || body.logo_url === '') {
      patch.logo_url = null
    } else {
      const url = String(body.logo_url).trim()
      if (url.length > 2048) {
        return NextResponse.json({ error: 'logo_url too long (>2048 chars)' }, { status: 400 })
      }
      // Light validation — accept http(s) absolute URLs or root-relative paths.
      if (!/^(https?:\/\/|\/)/i.test(url)) {
        return NextResponse.json(
          { error: 'logo_url must be an absolute http(s) URL or root-relative path' },
          { status: 400 },
        )
      }
      patch.logo_url = url
    }
  }

  if (body.accent_color !== undefined) {
    if (body.accent_color === null || body.accent_color === '') {
      patch.accent_color = null
    } else {
      const color = String(body.accent_color).trim()
      if (!HEX_COLOR.test(color)) {
        return NextResponse.json(
          { error: 'accent_color must be a hex color (e.g. #0e7490)' },
          { status: 400 },
        )
      }
      patch.accent_color = color
    }
  }

  if (body.monthly_ai_budget_usd !== undefined) {
    if (body.monthly_ai_budget_usd === null) {
      patch.monthly_ai_budget_usd = null
    } else {
      const num = Number(body.monthly_ai_budget_usd)
      if (!Number.isFinite(num) || num < 0 || num > 1_000_000) {
        return NextResponse.json(
          { error: 'monthly_ai_budget_usd must be a non-negative number ≤ 1,000,000' },
          { status: 400 },
        )
      }
      patch.monthly_ai_budget_usd = num
    }
  }

  if (body.settings !== undefined) {
    if (body.settings === null) {
      patch.settings = {}
    } else if (typeof body.settings !== 'object' || Array.isArray(body.settings)) {
      return NextResponse.json({ error: 'settings must be an object' }, { status: 400 })
    } else {
      patch.settings = body.settings
    }
  }

  if (body.default_email_signature !== undefined) {
    if (
      body.default_email_signature !== null &&
      typeof body.default_email_signature !== 'string'
    ) {
      return NextResponse.json(
        { error: 'default_email_signature must be a string or null' },
        { status: 400 },
      )
    }
    if (
      typeof body.default_email_signature === 'string' &&
      body.default_email_signature.length > 8192
    ) {
      return NextResponse.json(
        { error: 'default_email_signature exceeds 8KB' },
        { status: 400 },
      )
    }
    patch.default_email_signature = body.default_email_signature
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields provided to update' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()

  // Slug uniqueness (skip when clearing or when caller didn't change slug).
  if (typeof patch.slug === 'string') {
    const { data: clash } = await admin
      .from('companies')
      .select('id')
      .eq('slug', patch.slug as string)
      .maybeSingle()
    if (clash && (clash as { id: string }).id !== id) {
      return NextResponse.json({ error: 'slug already in use' }, { status: 409 })
    }
  }

  const { data: updated, error: updateErr } = await admin
    .from('companies')
    .update(patch)
    .eq('id', id)
    .select(
      'id, name, slug, logo_url, accent_color, monthly_ai_budget_usd, settings, default_email_signature, created_at, updated_at',
    )
    .single()

  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? 'Failed to update company' },
      { status: 500 },
    )
  }

  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'company.update',
      entity_type: 'company',
      entity_id: id,
      details: { changed: Object.keys(patch) },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ company: updated })
}
