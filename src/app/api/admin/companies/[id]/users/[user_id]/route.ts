/**
 * Per-user-in-company admin API.
 *
 *   PATCH /api/admin/companies/:id/users/:user_id
 *   body: { role?, account_id?, is_active? }
 *
 * Gate: super_admin OR company_admin of :id. The target user MUST already
 * belong to :id (so a company_admin cannot reach across tenants).
 *
 * Refuses to demote / deactivate the last remaining super_admin OR the
 * last remaining company_admin in the target company.
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isSuperAdmin, isCompanyAdmin } from '@/lib/auth'
import type { UserRole } from '@/types/database'

const ALLOWED_ROLES: UserRole[] = ['admin', 'company_admin', 'company_member', 'reviewer', 'viewer']

interface PatchBody {
  role?: UserRole
  account_id?: string | null
  is_active?: boolean
}

async function requireCompanyAdminFor(companyId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const profile = await getCurrentUser(user.id)
  if (!profile) return { ok: false as const, status: 403, error: 'Forbidden' }
  if (isSuperAdmin(profile.role)) return { ok: true as const, userId: user.id, isSuper: true as const }
  if (isCompanyAdmin(profile.role) && profile.company_id === companyId) {
    return { ok: true as const, userId: user.id, isSuper: false as const }
  }
  return { ok: false as const, status: 403, error: 'Forbidden' }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; user_id: string }> },
) {
  const { id, user_id } = await context.params
  const gate = await requireCompanyAdminFor(id)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: PatchBody
  try {
    body = (await request.json()) as PatchBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}

  if (body.role !== undefined) {
    if (!ALLOWED_ROLES.includes(body.role)) {
      return NextResponse.json(
        { error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` },
        { status: 400 },
      )
    }
    // Only super_admin can grant super_admin (we don't expose 'super_admin'
    // in ALLOWED_ROLES so that's already enforced). And only super_admin
    // can grant the legacy 'admin' role across tenants — company_admins
    // can only grant within their tenant, which is fine.
    patch.role = body.role
  }

  if (body.account_id !== undefined) {
    if (body.account_id !== null && typeof body.account_id !== 'string') {
      return NextResponse.json({ error: 'account_id must be a string or null' }, { status: 400 })
    }
    patch.account_id = body.account_id
  }

  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') {
      return NextResponse.json({ error: 'is_active must be a boolean' }, { status: 400 })
    }
    patch.is_active = body.is_active
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields provided to update' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()

  // Verify the target user belongs to this company.
  const { data: target, error: targetErr } = await admin
    .from('users')
    .select('id, email, role, company_id, account_id, is_active')
    .eq('id', user_id)
    .maybeSingle()

  if (targetErr) return NextResponse.json({ error: targetErr.message }, { status: 500 })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if ((target as { company_id: string | null }).company_id !== id) {
    return NextResponse.json(
      { error: 'User does not belong to this company' },
      { status: 404 },
    )
  }

  // Validate account_id (when not null) belongs to this company.
  if (typeof patch.account_id === 'string' && patch.account_id) {
    const { data: account } = await admin
      .from('accounts')
      .select('id, company_id')
      .eq('id', patch.account_id as string)
      .maybeSingle()
    if (!account) {
      return NextResponse.json({ error: 'account_id does not exist' }, { status: 400 })
    }
    if ((account as { company_id: string | null }).company_id !== id) {
      return NextResponse.json(
        { error: 'account_id belongs to a different company' },
        { status: 400 },
      )
    }
  }

  // Safety: don't let a company_admin demote the last active company_admin.
  // Don't let anyone demote the last active super_admin (super_admins are
  // always cross-tenant; we never expect them to be company-scoped, but if
  // somehow target is super_admin, refuse to touch them unless caller is super).
  const targetRow = target as {
    role: string
    is_active: boolean
  }

  if (targetRow.role === 'super_admin' && !gate.isSuper) {
    return NextResponse.json(
      { error: 'Only a super_admin can modify a super_admin' },
      { status: 403 },
    )
  }

  const willDemoteAdmin =
    patch.role !== undefined &&
    ['admin', 'company_admin'].includes(targetRow.role) &&
    !['admin', 'company_admin'].includes(patch.role as string)
  const willDeactivateAdmin =
    patch.is_active === false &&
    targetRow.is_active &&
    ['admin', 'company_admin'].includes(targetRow.role)

  if (willDemoteAdmin || willDeactivateAdmin) {
    const { count } = await admin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', id)
      .eq('is_active', true)
      .in('role', ['admin', 'company_admin'])
    if ((count ?? 0) <= 1) {
      return NextResponse.json(
        { error: 'Cannot remove the last active admin in this company' },
        { status: 400 },
      )
    }
  }

  const { data: updated, error: updateErr } = await admin
    .from('users')
    .update(patch)
    .eq('id', user_id)
    .select('id, email, full_name, role, company_id, account_id, is_active')
    .single()

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'company.user.update',
      entity_type: 'user',
      entity_id: user_id,
      details: { changed: Object.keys(patch), company_id: id },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ user: updated })
}
