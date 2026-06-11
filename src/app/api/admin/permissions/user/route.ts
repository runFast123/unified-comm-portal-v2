/**
 * Per-user RBAC overrides (highest-precedence layer).
 *
 *   GET /api/admin/permissions/user?user_id=  → { role, overrides: [{permission_key, effect}] }
 *   PUT /api/admin/permissions/user
 *     body { user_id, permission_key, effect: 'allow' | 'deny' | null }   (null deletes)
 *
 * The target user must be in the caller's company (super_admin: any). Writes
 * require action:permissions.manage. super_admin targets can't be overridden.
 */
import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireCompanyAdmin } from '@/lib/tenant-guard'
import { isKnownCatalogKey } from '@/lib/permissions/catalog'
import { userHasPermission } from '@/lib/permissions/server'
import { logAudit } from '@/lib/audit'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { UserRole } from '@/types/database'

async function resolveTargetUser(
  admin: SupabaseClient,
  ctx: { companyId: string | null; isSuperAdmin: boolean },
  userId: string
): Promise<{ ok: boolean; role?: string; companyId?: string | null }> {
  const { data } = await admin
    .from('users')
    .select('id, role, company_id')
    .eq('id', userId)
    .maybeSingle()
  if (!data) return { ok: false }
  const row = data as { role: string; company_id: string | null }
  if (ctx.isSuperAdmin) return { ok: true, role: row.role, companyId: row.company_id }
  if (row.company_id && row.company_id === ctx.companyId) {
    return { ok: true, role: row.role, companyId: row.company_id }
  }
  return { ok: false }
}

export async function GET(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const userId = new URL(request.url).searchParams.get('user_id')?.trim() ?? ''
  if (!userId) return NextResponse.json({ error: 'user_id required' }, { status: 400 })

  const admin = await createServiceRoleClient()
  const target = await resolveTargetUser(admin, gate.ctx, userId)
  if (!target.ok) return NextResponse.json({ error: 'Forbidden: user scope mismatch' }, { status: 403 })

  const { data } = await admin
    .from('user_permissions')
    .select('permission_key, effect')
    .eq('user_id', userId)

  return NextResponse.json({ role: target.role, overrides: data ?? [] })
}

export async function PUT(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { ctx } = gate

  const canManage = await userHasPermission(
    { id: ctx.userId, role: ctx.role as UserRole, company_id: ctx.companyId },
    'action:permissions.manage'
  )
  if (!canManage) {
    return NextResponse.json({ error: 'Missing permission: action:permissions.manage' }, { status: 403 })
  }

  let body: { user_id?: string; permission_key?: string; effect?: string | null }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const userId = typeof body.user_id === 'string' ? body.user_id : ''
  if (!userId) return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  const permissionKey = typeof body.permission_key === 'string' ? body.permission_key : ''
  if (!isKnownCatalogKey(permissionKey)) {
    return NextResponse.json({ error: 'Unknown permission_key' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()
  const target = await resolveTargetUser(admin, ctx, userId)
  if (!target.ok) return NextResponse.json({ error: 'Forbidden: user scope mismatch' }, { status: 403 })
  if (target.role === 'super_admin') {
    return NextResponse.json({ error: 'super_admin is all-access and cannot be overridden' }, { status: 400 })
  }

  // Replace: delete existing override, then insert when setting allow/deny.
  const { error: delErr } = await admin
    .from('user_permissions')
    .delete()
    .eq('user_id', userId)
    .eq('permission_key', permissionKey)
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })

  if (body.effect === 'allow' || body.effect === 'deny') {
    const { error: insErr } = await admin.from('user_permissions').insert({
      user_id: userId,
      permission_key: permissionKey,
      effect: body.effect,
      created_by: ctx.userId,
    })
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
  } else if (body.effect !== null && body.effect !== undefined) {
    return NextResponse.json({ error: "effect must be 'allow', 'deny', or null" }, { status: 400 })
  }

  // company_id = the TARGET user's tenant so its admins can see the row even
  // when the actor is a super_admin.
  void logAudit({
    user_id: ctx.userId,
    company_id: target.companyId ?? ctx.companyId,
    action: 'user_permissions_changed',
    entity_type: 'user',
    entity_id: userId,
    details: { permission_key: permissionKey, effect: body.effect ?? null },
  })

  return NextResponse.json({ success: true })
}
