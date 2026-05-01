/**
 * PATCH / DELETE /api/company-statuses/:id
 *
 * Admin / company-admin only. Scoped to the caller's own company unless they
 * are super_admin.
 *
 * DELETE is a soft-delete: we set `is_active=false` so any conversation rows
 * still pointing at the status (via free-text `secondary_status`) keep their
 * historical label, while the catalog stops surfacing it for new selections.
 */

import { NextResponse } from 'next/server'

import { logAudit } from '@/lib/audit'
import { isValidColor } from '@/lib/company-taxonomy'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

const MAX_NAME_LEN = 64
const MAX_DESCRIPTION_LEN = 280

interface PatchBody {
  name?: unknown
  color?: unknown
  description?: unknown
  sort_order?: unknown
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

  // Lookup existing row + scope-check.
  const { data: existing } = await g.admin
    .from('company_statuses')
    .select('id, company_id, name, color')
    .eq('id', id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Status not found' }, { status: 404 })
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

  if ('color' in body) {
    if (!isValidColor(body.color)) {
      return NextResponse.json({ error: 'color must be #RGB / #RRGGBB or a named CSS color' }, { status: 400 })
    }
    patch.color = (body.color as string).toLowerCase()
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

  if ('sort_order' in body) {
    const n = Number(body.sort_order)
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return NextResponse.json({ error: 'sort_order must be an integer' }, { status: 400 })
    }
    patch.sort_order = n
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
    .from('company_statuses')
    .update(patch)
    .eq('id', id)
    .select('id, company_id, name, color, description, sort_order, is_active, created_at')
    .single()
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'A status with that name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  void logAudit({
    user_id: g.user.id,
    action: 'company_status_updated',
    entity_type: 'company_status',
    entity_id: id,
    details: { fields: Object.keys(patch) },
  })

  return NextResponse.json({ status: updated })
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
    .from('company_statuses')
    .select('id, company_id, name')
    .eq('id', id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Status not found' }, { status: 404 })
  if (!isSuperAdmin(g.role) && existing.company_id !== g.companyId) {
    return NextResponse.json({ error: 'Forbidden: company scope mismatch' }, { status: 403 })
  }

  // Soft-delete keeps historical conversation.secondary_status labels readable.
  const { error } = await g.admin
    .from('company_statuses')
    .update({ is_active: false })
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  void logAudit({
    user_id: g.user.id,
    action: 'company_status_deleted',
    entity_type: 'company_status',
    entity_id: id,
    details: { name: existing.name, company_id: existing.company_id },
  })

  return NextResponse.json({ success: true })
}
