// Reply-templates API (single template).
//
//   GET    /api/templates/:id    fetch one (company members)
//   PATCH  /api/templates/:id    update one (company_admin / super_admin)
//   DELETE /api/templates/:id    delete one (company_admin / super_admin)
//
// Company isolation: every handler verifies that the target row belongs to
// the caller's company before letting the operation proceed. RLS enforces
// the same rule at the DB layer; this is defence-in-depth.

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

interface UpdateBody {
  name?: string
  subject?: string | null
  body?: string
  shortcut?: string | null
  category?: string | null
  is_active?: boolean
}

async function getSession(): Promise<
  | { ok: true; userId: string; companyId: string | null; role: string }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }

  const profile = await getCurrentUser(user.id)
  if (!profile) {
    return { ok: false, status: 403, error: 'No profile found for user' }
  }
  return {
    ok: true,
    userId: user.id,
    companyId: profile.company_id ?? null,
    role: profile.role || '',
  }
}

/** Returns the template iff the caller can access it; null/403 otherwise. */
async function loadAccessible(
  id: string,
  gate: { companyId: string | null; role: string }
): Promise<
  | { ok: true; template: Record<string, unknown> }
  | { ok: false; status: number; error: string }
> {
  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('reply_templates')
    .select(
      'id, company_id, account_id, title, subject, content, category, shortcut, usage_count, is_active, created_by, created_at, updated_at'
    )
    .eq('id', id)
    .maybeSingle()

  if (error) return { ok: false, status: 500, error: error.message }
  if (!data) return { ok: false, status: 404, error: 'Template not found' }

  if (!isSuperAdmin(gate.role)) {
    if (!gate.companyId) {
      return { ok: false, status: 403, error: 'Forbidden' }
    }
    if (data.company_id !== gate.companyId) {
      return { ok: false, status: 403, error: 'Forbidden' }
    }
  }
  return { ok: true, template: data }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await getSession()
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { id } = await context.params
  const result = await loadAccessible(id, gate)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json({ template: result.template })
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await getSession()
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  if (!isSuperAdmin(gate.role) && !isCompanyAdmin(gate.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await context.params
  const existing = await loadAccessible(id, gate)
  if (!existing.ok) {
    return NextResponse.json(
      { error: existing.error },
      { status: existing.status }
    )
  }

  let body: UpdateBody
  try {
    body = (await request.json()) as UpdateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if (body.name !== undefined) {
    const name = String(body.name).trim()
    if (!name) {
      return NextResponse.json(
        { error: 'name cannot be empty' },
        { status: 400 }
      )
    }
    patch.title = name.slice(0, 200)
  }
  if (body.subject !== undefined) {
    patch.subject =
      body.subject === null
        ? null
        : String(body.subject).trim().slice(0, 500) || null
  }
  if (body.body !== undefined) {
    const content = String(body.body)
    if (!content.trim()) {
      return NextResponse.json(
        { error: 'body cannot be empty' },
        { status: 400 }
      )
    }
    patch.content = content
  }
  if (body.shortcut !== undefined) {
    if (body.shortcut === null) {
      patch.shortcut = null
    } else {
      const cleaned = String(body.shortcut).trim().replace(/^\//, '').toLowerCase().slice(0, 64)
      patch.shortcut = cleaned || null
    }
  }
  if (body.category !== undefined) {
    patch.category =
      body.category === null
        ? null
        : String(body.category).trim().slice(0, 64) || null
  }
  if (body.is_active !== undefined) {
    patch.is_active = !!body.is_active
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: 'no fields to update' },
      { status: 400 }
    )
  }
  patch.updated_at = new Date().toISOString()

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('reply_templates')
    .update(patch)
    .eq('id', id)
    .select(
      'id, company_id, account_id, title, subject, content, category, shortcut, usage_count, is_active, created_by, created_at, updated_at'
    )
    .single()

  if (error) {
    const isUnique =
      (error as { code?: string }).code === '23505' ||
      /unique/i.test(error.message)
    if (isUnique) {
      return NextResponse.json(
        { error: 'A template with that shortcut already exists' },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ template: data })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await getSession()
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  if (!isSuperAdmin(gate.role) && !isCompanyAdmin(gate.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await context.params
  const existing = await loadAccessible(id, gate)
  if (!existing.ok) {
    return NextResponse.json(
      { error: existing.error },
      { status: existing.status }
    )
  }

  const admin = await createServiceRoleClient()
  const { error } = await admin.from('reply_templates').delete().eq('id', id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
