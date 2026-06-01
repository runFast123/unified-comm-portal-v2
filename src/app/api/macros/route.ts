/**
 * Workflow macros — reusable bundles of one-click conversation actions.
 *
 *   GET  /api/macros   → list this company's macros
 *   POST /api/macros   → create (admin / company-admin only)
 *
 * A macro NEVER sends a message. `actions` is validated against the documented
 * shape: { set_status?, add_tags?, assign_to?, set_priority?, reply_template_id? }.
 *
 * Same auth model as `/api/company-tags`: authenticate via the user client's
 * session, load role/company via the service-role client. super_admin may
 * target another company via the `selected_company_id` cookie (GET) or an
 * explicit `company_id` in the POST body.
 */

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import { validateActions } from '@/lib/macros'

const MAX_NAME_LEN = 64
const MAX_DESCRIPTION_LEN = 280

interface CreateBody {
  name?: unknown
  description?: unknown
  actions?: unknown
  is_active?: unknown
  company_id?: unknown
}

const MACRO_COLUMNS =
  'id, company_id, name, description, actions, is_active, created_by, created_at, updated_at'

export async function GET(request: Request) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role, company_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // super_admin may scope to a specific tenant via ?company_id= or the company
  // switcher's `selected_company_id` cookie; otherwise the caller's own company.
  const url = new URL(request.url)
  const queryCompanyId = url.searchParams.get('company_id')
  let targetCompanyId = profile.company_id || ''
  if (isSuperAdmin(profile.role)) {
    if (queryCompanyId) {
      targetCompanyId = queryCompanyId
    } else {
      const cookieStore = await cookies()
      const cookieCompanyId = cookieStore.get('selected_company_id')?.value?.trim() || ''
      targetCompanyId = cookieCompanyId || profile.company_id || ''
    }
  }

  if (!targetCompanyId) return NextResponse.json({ macros: [] })

  const { data, error } = await admin
    .from('macros')
    .select(MACRO_COLUMNS)
    .eq('company_id', targetCompanyId)
    .order('name', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ macros: data ?? [] })
}

export async function POST(request: Request) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role, company_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isCompanyAdmin(profile.role)) {
    return NextResponse.json({ error: 'Forbidden: admin only' }, { status: 403 })
  }

  let body: CreateBody
  try {
    body = (await request.json()) as CreateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (name.length > MAX_NAME_LEN) {
    return NextResponse.json({ error: `name must be <= ${MAX_NAME_LEN} chars` }, { status: 400 })
  }

  let description: string | null = null
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      return NextResponse.json({ error: 'description must be a string' }, { status: 400 })
    }
    if (body.description.length > MAX_DESCRIPTION_LEN) {
      return NextResponse.json({ error: `description must be <= ${MAX_DESCRIPTION_LEN} chars` }, { status: 400 })
    }
    description = body.description
  }

  const actionsResult = validateActions(body.actions)
  if (!actionsResult.ok) {
    return NextResponse.json({ error: actionsResult.error }, { status: 400 })
  }

  let isActive = true
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') {
      return NextResponse.json({ error: 'is_active must be a boolean' }, { status: 400 })
    }
    isActive = body.is_active
  }

  // Resolve the owning company. super_admin may target another company via an
  // explicit company_id; everyone else is pinned to their own.
  let companyId: string | null = profile.company_id
  if (isSuperAdmin(profile.role) && typeof body.company_id === 'string' && body.company_id) {
    companyId = body.company_id
  }
  if (!companyId) {
    return NextResponse.json({ error: 'No company scope' }, { status: 400 })
  }

  const { data: inserted, error } = await admin
    .from('macros')
    .insert({
      company_id: companyId,
      name,
      description,
      actions: actionsResult.value,
      is_active: isActive,
      created_by: user.id,
    })
    .select(MACRO_COLUMNS)
    .single()
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'A macro with that name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  try {
    await admin.from('audit_log').insert({
      user_id: user.id,
      company_id: companyId,
      action: 'macro.created',
      entity_type: 'macro',
      entity_id: inserted.id,
      details: { name, company_id: companyId },
    })
  } catch {
    /* non-critical */
  }

  return NextResponse.json({ macro: inserted }, { status: 201 })
}
