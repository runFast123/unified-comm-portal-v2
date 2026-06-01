/**
 * PATCH / DELETE /api/macros/:id
 *
 * Admin / company-admin only. Scoped to the caller's own company unless they
 * are super_admin (mirrors `/api/company-tags/:id`). Macros are hard-deleted.
 *
 * A macro NEVER sends a message — see `/api/conversations/[id]/apply-macro`
 * for how it's applied (status / tags / assignee / priority only).
 */

import { NextResponse } from 'next/server'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import { validateActions } from '@/lib/macros'

const MAX_NAME_LEN = 64
const MAX_DESCRIPTION_LEN = 280

const MACRO_COLUMNS =
  'id, company_id, name, description, actions, is_active, created_by, created_at, updated_at'

interface PatchBody {
  name?: unknown
  description?: unknown
  actions?: unknown
  is_active?: unknown
}

async function gate() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }

  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role, company_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile) return { ok: false as const, status: 401, error: 'Unauthorized' }
  if (!isCompanyAdmin(profile.role)) {
    return { ok: false as const, status: 403, error: 'Forbidden: admin only' }
  }
  return {
    ok: true as const,
    admin,
    user,
    role: profile.role as string,
    companyId: profile.company_id as string | null,
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const g = await gate()
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  let body: PatchBody
  try {
    body = (await request.json()) as PatchBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { data: existing } = await g.admin
    .from('macros')
    .select('id, company_id, name')
    .eq('id', id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Macro not found' }, { status: 404 })
  if (!isSuperAdmin(g.role) && existing.company_id !== g.companyId) {
    return NextResponse.json({ error: 'Forbidden: company scope mismatch' }, { status: 403 })
  }

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

  if ('description' in body) {
    if (body.description === null) {
      patch.description = null
    } else if (typeof body.description === 'string') {
      if (body.description.length > MAX_DESCRIPTION_LEN) {
        return NextResponse.json({ error: `description must be <= ${MAX_DESCRIPTION_LEN} chars` }, { status: 400 })
      }
      patch.description = body.description
    } else {
      return NextResponse.json({ error: 'description must be a string or null' }, { status: 400 })
    }
  }

  if ('actions' in body) {
    const result = validateActions(body.actions)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }
    patch.actions = result.value
  }

  if ('is_active' in body) {
    if (typeof body.is_active !== 'boolean') {
      return NextResponse.json({ error: 'is_active must be a boolean' }, { status: 400 })
    }
    patch.is_active = body.is_active
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data: updated, error } = await g.admin
    .from('macros')
    .update(patch)
    .eq('id', id)
    .select(MACRO_COLUMNS)
    .single()
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'A macro with that name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  try {
    await g.admin.from('audit_log').insert({
      user_id: g.user.id,
      company_id: existing.company_id,
      action: 'macro.updated',
      entity_type: 'macro',
      entity_id: id,
      details: { fields: Object.keys(patch) },
    })
  } catch {
    /* non-critical */
  }

  return NextResponse.json({ macro: updated })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const g = await gate()
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const { data: existing } = await g.admin
    .from('macros')
    .select('id, company_id, name')
    .eq('id', id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Macro not found' }, { status: 404 })
  if (!isSuperAdmin(g.role) && existing.company_id !== g.companyId) {
    return NextResponse.json({ error: 'Forbidden: company scope mismatch' }, { status: 403 })
  }

  const { error } = await g.admin
    .from('macros')
    .delete()
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  try {
    await g.admin.from('audit_log').insert({
      user_id: g.user.id,
      company_id: existing.company_id,
      action: 'macro.deleted',
      entity_type: 'macro',
      entity_id: id,
      details: { name: existing.name, company_id: existing.company_id },
    })
  } catch {
    /* non-critical */
  }

  return NextResponse.json({ success: true })
}
