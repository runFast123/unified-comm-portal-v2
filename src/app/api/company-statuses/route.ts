/**
 * Company-defined conversation statuses.
 *
 *   GET  /api/company-statuses       → list this company's active statuses
 *   POST /api/company-statuses       → create (admin/CA only)
 *
 * Auth model:
 *   - super_admin can read/write any company; the body must include `company_id`
 *     (or pass ?company_id= on GET).
 *   - company_admin / admin write within their own company.
 *   - company_member can read only.
 *
 * Mutations are gated by RLS at the database layer too — this endpoint just
 * fails fast with a friendly 403 instead of letting the SQL fail.
 */

import { NextResponse } from 'next/server'

import { logAudit } from '@/lib/audit'
import {
  getCompanyStatuses,
  isValidColor,
  DEFAULT_TAXONOMY_COLOR,
} from '@/lib/company-taxonomy'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

// Hard caps so a misbehaving client can't paste novels into the DB.
const MAX_NAME_LEN = 64
const MAX_DESCRIPTION_LEN = 280

interface CreateBody {
  name?: unknown
  color?: unknown
  description?: unknown
  sort_order?: unknown
  company_id?: unknown
}

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

  // super_admin gets cross-company list when ?company_id= is passed; otherwise
  // returns own company's catalog (or empty if untethered).
  const url = new URL(request.url)
  const queryCompanyId = url.searchParams.get('company_id')
  const targetCompanyId = isSuperAdmin(profile.role)
    ? (queryCompanyId || profile.company_id || '')
    : (profile.company_id || '')

  if (!targetCompanyId) return NextResponse.json({ statuses: [] })

  try {
    const statuses = await getCompanyStatuses(admin, targetCompanyId)
    return NextResponse.json({ statuses })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    )
  }
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

  const color = body.color === undefined ? DEFAULT_TAXONOMY_COLOR : body.color
  if (!isValidColor(color)) {
    return NextResponse.json({ error: 'color must be #RGB / #RRGGBB or a named CSS color' }, { status: 400 })
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

  let sortOrder = 0
  if (body.sort_order !== undefined && body.sort_order !== null) {
    const n = Number(body.sort_order)
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return NextResponse.json({ error: 'sort_order must be an integer' }, { status: 400 })
    }
    sortOrder = n
  }

  // super_admin must specify company_id; everyone else uses their own.
  let companyId: string | null = profile.company_id
  if (isSuperAdmin(profile.role) && typeof body.company_id === 'string' && body.company_id) {
    companyId = body.company_id
  }
  if (!companyId) {
    return NextResponse.json({ error: 'No company scope' }, { status: 400 })
  }

  const { data: inserted, error } = await admin
    .from('company_statuses')
    .insert({
      company_id: companyId,
      name,
      color,
      description,
      sort_order: sortOrder,
      is_active: true,
    })
    .select('id, company_id, name, color, description, sort_order, is_active, created_at')
    .single()
  if (error) {
    // 23505 = unique violation (case-insensitive duplicate name in the same company)
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'A status with that name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  void logAudit({
    user_id: user.id,
    action: 'company_status_created',
    entity_type: 'company_status',
    entity_id: inserted.id,
    details: { company_id: companyId, name },
  })

  return NextResponse.json({ status: inserted }, { status: 201 })
}
