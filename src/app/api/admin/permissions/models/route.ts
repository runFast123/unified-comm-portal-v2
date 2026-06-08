/**
 * AI model assignment (RBAC) — route a role's or user's AI calls to a specific
 * configured provider instead of the company's active one.
 *
 *   GET → { companyId, providers: [{id,name,model,is_active}], assignments }
 *   PUT   body { scope: 'role'|'user', role?, user_id?, ai_provider_id: string|null }
 *         ai_provider_id=null clears the assignment (→ company default).
 *
 * requireCompanyAdmin + service-role with TS scoping; writes self-gate on
 * action:permissions.manage. Providers must belong to the target company; a
 * user assignment requires the user to share the caller's company.
 */
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireCompanyAdmin } from '@/lib/tenant-guard'
import { userHasPermission } from '@/lib/permissions/server'
import type { UserRole } from '@/types/database'

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

  const companyId = await resolveTargetCompanyId(request, gate.ctx)
  if (!companyId) return NextResponse.json({ companyId: null, providers: [], assignments: [] })

  const admin = await createServiceRoleClient()
  const { data: providers } = await admin
    .from('ai_providers')
    .select('id, name, model, is_active')
    .eq('company_id', companyId)
    .order('name', { ascending: true })
  const { data: assignments } = await admin
    .from('ai_model_assignments')
    .select('id, role, user_id, ai_provider_id')
    .eq('company_id', companyId)

  return NextResponse.json({
    companyId,
    providers: providers ?? [],
    assignments: assignments ?? [],
  })
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

  let body: { scope?: string; role?: string; user_id?: string; ai_provider_id?: string | null }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const companyId = await resolveTargetCompanyId(request, ctx)
  if (!companyId) return NextResponse.json({ error: 'No company scope' }, { status: 400 })

  const admin = await createServiceRoleClient()
  const providerId = body.ai_provider_id ?? null

  // When assigning (not clearing), the provider must belong to the company.
  if (providerId) {
    const { data: prov } = await admin
      .from('ai_providers')
      .select('id')
      .eq('id', providerId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!prov) return NextResponse.json({ error: 'Unknown provider for this company' }, { status: 400 })
  }

  if (body.scope === 'role') {
    const role = typeof body.role === 'string' ? body.role : ''
    if (!MANAGEABLE_ROLES.has(role)) {
      return NextResponse.json({ error: 'Invalid or non-editable role' }, { status: 400 })
    }
    const { error: delErr } = await admin
      .from('ai_model_assignments')
      .delete()
      .eq('company_id', companyId)
      .eq('role', role)
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
    if (providerId) {
      const { error: insErr } = await admin.from('ai_model_assignments').insert({
        company_id: companyId,
        role,
        ai_provider_id: providerId,
        created_by: ctx.userId,
      })
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
    }
  } else if (body.scope === 'user') {
    const userId = typeof body.user_id === 'string' ? body.user_id : ''
    if (!userId) return NextResponse.json({ error: 'user_id required' }, { status: 400 })
    const { data: target } = await admin
      .from('users')
      .select('id, company_id')
      .eq('id', userId)
      .maybeSingle()
    const targetCompany = (target as { company_id?: string | null } | null)?.company_id ?? null
    if (!target || (!ctx.isSuperAdmin && targetCompany !== ctx.companyId)) {
      return NextResponse.json({ error: 'Forbidden: user scope mismatch' }, { status: 403 })
    }
    const { error: delErr } = await admin
      .from('ai_model_assignments')
      .delete()
      .eq('company_id', companyId)
      .eq('user_id', userId)
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
    if (providerId) {
      const { error: insErr } = await admin.from('ai_model_assignments').insert({
        company_id: companyId,
        user_id: userId,
        ai_provider_id: providerId,
        created_by: ctx.userId,
      })
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
    }
  } else {
    return NextResponse.json({ error: "scope must be 'role' or 'user'" }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
