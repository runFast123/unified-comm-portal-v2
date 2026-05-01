/**
 * Company-default email signature management. Admin-only.
 *
 *   GET  /api/admin/companies/:id/signature -> read default + name
 *   POST /api/admin/companies/:id/signature -> write default
 *
 * Coordinates with the parallel multi-tenancy migration: this route only
 * reads/writes the `default_email_signature` column, never anything else
 * on `companies`.
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

interface UpdateBody {
  default_email_signature?: string | null
}

/**
 * Auth gate for the company-default signature endpoints.
 *
 * Required: caller must be (a) super_admin (cross-tenant) OR
 * (b) a company_admin/admin whose `company_id` matches the URL `:id`.
 *
 * FIX: previously this only checked the role; a company_admin of company A
 * could overwrite company B's signature. We now require the caller's
 * `company_id` to equal the target `:id` for non-super_admin roles.
 */
async function requireAdminFor(companyId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }

  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role, company_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile?.role) {
    return { ok: false as const, status: 403, error: 'Admin only' }
  }
  const role = profile.role as string
  if (isSuperAdmin(role)) {
    return { ok: true as const, admin, userId: user.id }
  }
  if (!isCompanyAdmin(role)) {
    return { ok: false as const, status: 403, error: 'Admin only' }
  }
  // Non-super_admin must belong to the target company.
  if ((profile as { company_id?: string | null }).company_id !== companyId) {
    return { ok: false as const, status: 403, error: 'Forbidden: cross-company access denied' }
  }
  return { ok: true as const, admin, userId: user.id }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const gate = await requireAdminFor(id)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { data, error } = await gate.admin
    .from('companies')
    .select('id, name, default_email_signature')
    .eq('id', id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Company not found' }, { status: 404 })
  return NextResponse.json({ company: data })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const gate = await requireAdminFor(id)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: UpdateBody
  try {
    body = (await request.json()) as UpdateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (body.default_email_signature !== undefined) {
    if (
      body.default_email_signature !== null &&
      typeof body.default_email_signature !== 'string'
    ) {
      return NextResponse.json(
        { error: 'default_email_signature must be a string or null' },
        { status: 400 },
      )
    }
    if (
      typeof body.default_email_signature === 'string' &&
      body.default_email_signature.length > 8192
    ) {
      return NextResponse.json(
        { error: 'default_email_signature exceeds 8KB' },
        { status: 400 },
      )
    }
  } else {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { error: updateErr } = await gate.admin
    .from('companies')
    .update({ default_email_signature: body.default_email_signature })
    .eq('id', id)
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  try {
    await gate.admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'company.signature.update',
      entity_type: 'company',
      entity_id: id,
      details: { has_signature: body.default_email_signature !== null && body.default_email_signature !== '' },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ success: true })
}
