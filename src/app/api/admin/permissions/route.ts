/**
 * RBAC role-permission management.
 *
 *   GET /api/admin/permissions[?scope=platform][&company_id=]
 *     → { scope, companyId, roleDeltas: [{role, permission_key, allowed}], users }
 *   PUT /api/admin/permissions
 *     body { role, permission_key, allowed: boolean | null, scope?: 'company'|'platform' }
 *     allowed=null deletes the delta (revert to the code baseline).
 *
 * Auth mirrors /api/ai-providers: requireCompanyAdmin + service-role with
 * TypeScript scoping. super_admin may target another company via the company
 * switcher cookie / ?company_id=, or edit platform defaults via scope=platform.
 * Writes additionally require the caller to hold action:permissions.manage.
 */
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireCompanyAdmin } from '@/lib/tenant-guard'
import { isKnownCatalogKey } from '@/lib/permissions/catalog'
import { userHasPermission } from '@/lib/permissions/server'
import { logAudit } from '@/lib/audit'
import type { UserRole } from '@/types/database'

// Roles an admin may edit here. super_admin is all-access and never editable.
const MANAGEABLE_ROLES = new Set<string>([
  'admin',
  'company_admin',
  'supervisor',
  'company_member',
  'reviewer',
  'viewer',
])

async function resolveTargetCompanyId(
  request: Request,
  ctx: { companyId: string | null; isSuperAdmin: boolean }
): Promise<string> {
  let targetCompanyId = ctx.companyId || ''
  if (ctx.isSuperAdmin) {
    const queryCompanyId = new URL(request.url).searchParams.get('company_id')
    if (queryCompanyId) {
      targetCompanyId = queryCompanyId
    } else {
      const cookieStore = await cookies()
      targetCompanyId = cookieStore.get('selected_company_id')?.value?.trim() || ctx.companyId || ''
    }
  }
  return targetCompanyId
}

export async function GET(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { ctx } = gate

  const wantsPlatform =
    new URL(request.url).searchParams.get('scope') === 'platform' && ctx.isSuperAdmin
  const admin = await createServiceRoleClient()
  const targetCompanyId = await resolveTargetCompanyId(request, ctx)

  let roleQuery = admin.from('role_permissions').select('role, permission_key, allowed')
  if (wantsPlatform) {
    roleQuery = roleQuery.is('company_id', null)
  } else {
    if (!targetCompanyId) {
      return NextResponse.json({ scope: 'company', companyId: null, roleDeltas: [], users: [] })
    }
    roleQuery = roleQuery.eq('company_id', targetCompanyId)
  }
  const { data: deltaRows } = await roleQuery

  let users: Array<{ id: string; full_name: string | null; email: string; role: string }> = []
  if (targetCompanyId) {
    const { data: userRows } = await admin
      .from('users')
      .select('id, full_name, email, role')
      .eq('company_id', targetCompanyId)
      .order('full_name', { ascending: true })
    users = (userRows ?? []) as typeof users
  }

  return NextResponse.json({
    scope: wantsPlatform ? 'platform' : 'company',
    companyId: wantsPlatform ? null : targetCompanyId,
    roleDeltas: (deltaRows ?? []) as Array<{ role: string; permission_key: string; allowed: boolean }>,
    users,
  })
}

export async function PUT(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { ctx } = gate

  // Fine-grained self-gate beyond the admin role (a super_admin may revoke it).
  const canManage = await userHasPermission(
    { id: ctx.userId, role: ctx.role as UserRole, company_id: ctx.companyId },
    'action:permissions.manage'
  )
  if (!canManage) {
    return NextResponse.json({ error: 'Missing permission: action:permissions.manage' }, { status: 403 })
  }

  let body: { role?: string; permission_key?: string; allowed?: boolean | null; scope?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const role = typeof body.role === 'string' ? body.role : ''
  if (!MANAGEABLE_ROLES.has(role)) {
    return NextResponse.json({ error: 'Invalid or non-editable role' }, { status: 400 })
  }
  const permissionKey = typeof body.permission_key === 'string' ? body.permission_key : ''
  if (!isKnownCatalogKey(permissionKey)) {
    return NextResponse.json({ error: 'Unknown permission_key' }, { status: 400 })
  }

  const isPlatform = body.scope === 'platform'
  if (isPlatform && !ctx.isSuperAdmin) {
    return NextResponse.json({ error: 'Only super_admin can edit platform defaults' }, { status: 403 })
  }
  const companyId = isPlatform ? null : await resolveTargetCompanyId(request, ctx)
  if (!isPlatform && !companyId) {
    return NextResponse.json({ error: 'No company scope' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()

  // "Replace" semantics compatible with the COALESCE() expression unique index:
  // delete any existing delta, then insert when setting an explicit allow/deny.
  // allowed=null leaves it deleted (= revert to the code baseline).
  let del = admin
    .from('role_permissions')
    .delete()
    .eq('role', role)
    .eq('permission_key', permissionKey)
  del = isPlatform ? del.is('company_id', null) : del.eq('company_id', companyId)
  const { error: delErr } = await del
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })

  if (body.allowed === true || body.allowed === false) {
    const { error: insErr } = await admin.from('role_permissions').insert({
      company_id: companyId,
      role,
      permission_key: permissionKey,
      allowed: body.allowed,
      created_by: ctx.userId,
    })
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
  } else if (body.allowed !== null && body.allowed !== undefined) {
    return NextResponse.json({ error: 'allowed must be boolean or null' }, { status: 400 })
  }

  // company_id explicit: the actor may be super_admin editing another tenant
  // (platform scope → null, visible to super_admins only).
  void logAudit({
    user_id: ctx.userId,
    company_id: companyId,
    action: 'role_permissions_changed',
    entity_type: 'role_permissions',
    details: {
      role,
      permission_key: permissionKey,
      allowed: body.allowed ?? null,
      scope: isPlatform ? 'platform' : 'company',
    },
  })

  return NextResponse.json({ success: true })
}
