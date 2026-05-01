/**
 * Company-defined tag catalog. Drives autocomplete + colors for the existing
 * free-form `conversations.tags text[]` column.
 *
 *   GET  /api/company-tags       → list this company's tags
 *   POST /api/company-tags       → create (admin/CA only)
 *
 * Same auth model as `/api/company-statuses` — see that file for details.
 */

import { NextResponse } from 'next/server'

import { logAudit } from '@/lib/audit'
import {
  getCompanyTags,
  isValidColor,
  DEFAULT_TAXONOMY_COLOR,
} from '@/lib/company-taxonomy'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

const MAX_NAME_LEN = 48
const MAX_DESCRIPTION_LEN = 280

interface CreateBody {
  name?: unknown
  color?: unknown
  description?: unknown
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

  const url = new URL(request.url)
  const queryCompanyId = url.searchParams.get('company_id')
  const targetCompanyId = isSuperAdmin(profile.role)
    ? (queryCompanyId || profile.company_id || '')
    : (profile.company_id || '')

  if (!targetCompanyId) return NextResponse.json({ tags: [] })

  try {
    const tags = await getCompanyTags(admin, targetCompanyId)
    return NextResponse.json({ tags })
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

  let companyId: string | null = profile.company_id
  if (isSuperAdmin(profile.role) && typeof body.company_id === 'string' && body.company_id) {
    companyId = body.company_id
  }
  if (!companyId) {
    return NextResponse.json({ error: 'No company scope' }, { status: 400 })
  }

  const { data: inserted, error } = await admin
    .from('company_tags')
    .insert({
      company_id: companyId,
      name,
      color,
      description,
      created_by: user.id,
    })
    .select('id, company_id, name, color, description, created_by, created_at')
    .single()
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'A tag with that name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  void logAudit({
    user_id: user.id,
    action: 'company_tag_created',
    entity_type: 'company_tag',
    entity_id: inserted.id,
    details: { company_id: companyId, name },
  })

  return NextResponse.json({ tag: inserted }, { status: 201 })
}
