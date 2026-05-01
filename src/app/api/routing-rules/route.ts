// CRUD for `public.routing_rules`. Admin-only.
//
// GET   /api/routing-rules          → list all rules (admin sees everything)
// POST  /api/routing-rules          → create rule
// PATCH /api/routing-rules?id=...   → update rule
// DELETE /api/routing-rules?id=...  → delete rule

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

/**
 * Admin gate that recognises every privileged role in the multi-tenancy
 * model: super_admin, admin, company_admin. The original implementation
 * used `role === 'admin'` literal which silently denied the new roles
 * AND granted legacy `admin` cross-company powers (no scoping). This
 * helper returns the caller's company so the route can scope reads/writes.
 */
async function requireAdmin(): Promise<
  | { ok: true; userId: string; role: string; companyId: string | null; isSuper: boolean }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }

  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role, company_id')
    .eq('id', user.id)
    .maybeSingle()
  const role = profile?.role as string | undefined
  if (!role || !isCompanyAdmin(role)) {
    return { ok: false, status: 403, error: 'Admin only' }
  }
  return {
    ok: true,
    userId: user.id,
    role,
    companyId: (profile?.company_id as string | null) ?? null,
    isSuper: isSuperAdmin(role),
  }
}

interface RuleBody {
  name?: string
  is_active?: boolean
  priority?: number
  conditions?: Array<{ field: string; op: string; value: unknown }>
  match_mode?: 'all' | 'any'
  set_priority?: string | null
  set_status?: string | null
  add_tags?: string[] | null
  assign_to_team?: string | null
  assign_to_user?: string | null
  use_round_robin?: boolean
  account_id?: string | null
}

function sanitizeBody(body: RuleBody): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (body.name !== undefined) patch.name = String(body.name).slice(0, 200)
  if (body.is_active !== undefined) patch.is_active = !!body.is_active
  if (body.priority !== undefined) patch.priority = Number(body.priority) || 100
  if (body.conditions !== undefined)
    patch.conditions = Array.isArray(body.conditions) ? body.conditions : []
  if (body.match_mode !== undefined)
    patch.match_mode = body.match_mode === 'any' ? 'any' : 'all'
  if (body.set_priority !== undefined) patch.set_priority = body.set_priority || null
  if (body.set_status !== undefined) patch.set_status = body.set_status || null
  if (body.add_tags !== undefined)
    patch.add_tags = Array.isArray(body.add_tags) ? body.add_tags.filter(Boolean) : null
  if (body.assign_to_team !== undefined)
    patch.assign_to_team = body.assign_to_team || null
  if (body.assign_to_user !== undefined)
    patch.assign_to_user = body.assign_to_user || null
  if (body.use_round_robin !== undefined)
    patch.use_round_robin = !!body.use_round_robin
  if (body.account_id !== undefined) patch.account_id = body.account_id || null
  return patch
}

/**
 * Resolve the set of account ids the caller is allowed to manage rules for.
 * super_admin sees everything (returns null = no filter). Everyone else is
 * scoped to accounts in their own company.
 */
async function allowedAccountIds(
  admin: ReturnType<typeof createServiceRoleClient> extends Promise<infer C> ? C : never,
  gate: { isSuper: boolean; companyId: string | null }
): Promise<string[] | null> {
  if (gate.isSuper) return null
  if (!gate.companyId) return [] // company_admin without a company → can't see any account-scoped rules
  const { data } = await admin
    .from('accounts')
    .select('id')
    .eq('company_id', gate.companyId)
  return (data || []).map((a) => a.id as string)
}

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = await createServiceRoleClient()
  // Build the company-scoped filter:
  //   super_admin → everything
  //   company_admin → rules with account_id in their company OR account_id IS NULL (global rules)
  let query = admin
    .from('routing_rules')
    .select('*')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false })

  if (!gate.isSuper) {
    const ids = await allowedAccountIds(admin, gate)
    if (ids === null) {
      // shouldn't happen (isSuper would be true); defensive
    } else if (ids.length === 0) {
      // No company accounts visible — only return global rules
      query = query.is('account_id', null)
    } else {
      // PostgREST: account_id IN (ids) OR account_id IS NULL
      query = query.or(`account_id.in.(${ids.join(',')}),account_id.is.null`)
    }
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ rules: data || [] })
}

export async function POST(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: RuleBody
  try {
    body = (await request.json()) as RuleBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()

  // If caller specified account_id, verify it belongs to their company.
  // Only super_admin can create global (account_id=null) rules or
  // cross-company rules.
  if (body.account_id && !gate.isSuper) {
    const { data: acc } = await admin
      .from('accounts')
      .select('company_id')
      .eq('id', body.account_id)
      .maybeSingle()
    if (!acc || acc.company_id !== gate.companyId) {
      return NextResponse.json(
        { error: 'Forbidden: account is not in your company' },
        { status: 403 }
      )
    }
  } else if (body.account_id === null && !gate.isSuper) {
    return NextResponse.json(
      { error: 'Only super_admin can create global routing rules' },
      { status: 403 }
    )
  }

  const patch = sanitizeBody(body)
  patch.created_by = gate.userId
  if (patch.priority === undefined) patch.priority = 100
  if (patch.match_mode === undefined) patch.match_mode = 'all'
  if (patch.is_active === undefined) patch.is_active = true
  if (patch.use_round_robin === undefined) patch.use_round_robin = false

  const { data, error } = await admin
    .from('routing_rules')
    .insert(patch)
    .select('*')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ rule: data }, { status: 201 })
}

/**
 * Verify the caller may modify the given rule. Returns null on success,
 * or a NextResponse with the error to return.
 */
async function authorizeRuleAccess(
  admin: Awaited<ReturnType<typeof createServiceRoleClient>>,
  ruleId: string,
  gate: { isSuper: boolean; companyId: string | null }
): Promise<NextResponse | null> {
  const { data: rule } = await admin
    .from('routing_rules')
    .select('account_id')
    .eq('id', ruleId)
    .maybeSingle()
  if (!rule) {
    return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
  }
  if (gate.isSuper) return null
  // Global rules (account_id null) are super_admin-only to mutate
  if (rule.account_id === null) {
    return NextResponse.json(
      { error: 'Only super_admin may modify global rules' },
      { status: 403 }
    )
  }
  const { data: acc } = await admin
    .from('accounts')
    .select('company_id')
    .eq('id', rule.account_id)
    .maybeSingle()
  if (!acc || acc.company_id !== gate.companyId) {
    return NextResponse.json(
      { error: 'Forbidden: rule belongs to another company' },
      { status: 403 }
    )
  }
  return null
}

export async function PATCH(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 })

  let body: RuleBody
  try {
    body = (await request.json()) as RuleBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const patch = sanitizeBody(body)
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()
  const denied = await authorizeRuleAccess(admin, id, gate)
  if (denied) return denied

  // If caller is changing account_id, the new value must also be in their company
  if (patch.account_id !== undefined && patch.account_id !== null && !gate.isSuper) {
    const { data: acc } = await admin
      .from('accounts')
      .select('company_id')
      .eq('id', patch.account_id as string)
      .maybeSingle()
    if (!acc || acc.company_id !== gate.companyId) {
      return NextResponse.json(
        { error: 'Forbidden: cannot move rule to another company' },
        { status: 403 }
      )
    }
  }

  const { data, error } = await admin
    .from('routing_rules')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ rule: data })
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 })

  const admin = await createServiceRoleClient()
  const denied = await authorizeRuleAccess(admin, id, gate)
  if (denied) return denied

  const { error } = await admin.from('routing_rules').delete().eq('id', id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
