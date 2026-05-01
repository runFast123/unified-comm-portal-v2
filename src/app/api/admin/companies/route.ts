/**
 * Companies admin API.
 *
 *   GET  /api/admin/companies  → list (super_admin only)
 *   POST /api/admin/companies  → create (super_admin only)
 *
 * Both endpoints use the service-role client so they bypass RLS; the
 * privilege check happens in TS via `isSuperAdmin`.
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isSuperAdmin } from '@/lib/auth'

interface CreateBody {
  name?: string
  slug?: string | null
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

async function requireSuperAdmin() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const profile = await getCurrentUser(user.id)
  if (!isSuperAdmin(profile?.role)) {
    return { ok: false as const, status: 403, error: 'Super admin only' }
  }
  return { ok: true as const, userId: user.id }
}

export async function GET() {
  const gate = await requireSuperAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('companies')
    .select(
      'id, name, slug, logo_url, accent_color, monthly_ai_budget_usd, created_at, updated_at'
    )
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ companies: data ?? [] })
}

export async function POST(request: Request) {
  const gate = await requireSuperAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: CreateBody
  try {
    body = (await request.json()) as CreateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const name = (body.name ?? '').trim()
  if (!name || name.length > 200) {
    return NextResponse.json({ error: 'name is required (1-200 chars)' }, { status: 400 })
  }

  let slug: string | null = null
  if (body.slug !== undefined && body.slug !== null && body.slug !== '') {
    const candidate = String(body.slug).trim().toLowerCase()
    if (!SLUG_PATTERN.test(candidate)) {
      return NextResponse.json(
        { error: 'slug must be 1-64 chars of lowercase letters, digits, or dashes' },
        { status: 400 },
      )
    }
    slug = candidate
  }

  const admin = await createServiceRoleClient()

  // Enforce slug uniqueness up front (DB has a partial unique index, but a
  // friendly 409 is nicer than a postgres error).
  if (slug) {
    const { data: existing } = await admin
      .from('companies')
      .select('id')
      .eq('slug', slug)
      .maybeSingle()
    if (existing) {
      return NextResponse.json({ error: 'slug already in use' }, { status: 409 })
    }
  }

  const { data: created, error: insertErr } = await admin
    .from('companies')
    .insert({ name, slug })
    .select('id, name, slug, logo_url, accent_color, monthly_ai_budget_usd, created_at, updated_at')
    .single()

  if (insertErr || !created) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'Failed to create company' },
      { status: 500 },
    )
  }

  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'company.create',
      entity_type: 'company',
      entity_id: created.id,
      details: { name, slug },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ company: created }, { status: 201 })
}
