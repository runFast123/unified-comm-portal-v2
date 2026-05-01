/**
 * Invite a user to a company.
 *
 *   POST /api/admin/companies/:id/users/invite
 *   body: { email, role?, full_name?, account_id? }
 *
 * Gate: super_admin OR company_admin of :id.
 *
 * Strategy:
 *   1) Try Supabase Auth admin `inviteUserByEmail` to send an invite email.
 *   2) Either way (invite succeeds or user already exists), upsert the
 *      `public.users` row with role + company_id + (optional) account_id so
 *      they're scoped to the company immediately on next sign-in.
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isSuperAdmin, isCompanyAdmin } from '@/lib/auth'
import type { UserRole } from '@/types/database'

const ALLOWED_ROLES: UserRole[] = ['admin', 'company_admin', 'company_member', 'reviewer', 'viewer']

interface InviteBody {
  email?: string
  full_name?: string | null
  role?: UserRole
  account_id?: string | null
}

async function requireCompanyAdminFor(companyId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const profile = await getCurrentUser(user.id)
  if (!profile) return { ok: false as const, status: 403, error: 'Forbidden' }
  if (isSuperAdmin(profile.role)) return { ok: true as const, userId: user.id }
  if (isCompanyAdmin(profile.role) && profile.company_id === companyId) {
    return { ok: true as const, userId: user.id }
  }
  return { ok: false as const, status: 403, error: 'Forbidden' }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const gate = await requireCompanyAdminFor(id)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: InviteBody
  try {
    body = (await request.json()) as InviteBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const email = (body.email ?? '').trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Valid email required' }, { status: 400 })
  }

  const role: UserRole = (body.role ?? 'company_member') as UserRole
  if (!ALLOWED_ROLES.includes(role)) {
    return NextResponse.json(
      { error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` },
      { status: 400 },
    )
  }

  const accountId = body.account_id ?? null
  const fullName = body.full_name?.toString().trim() || null

  const admin = await createServiceRoleClient()

  // Validate company exists.
  const { data: company } = await admin
    .from('companies')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

  // Validate account_id (when provided) belongs to this company.
  if (accountId) {
    const { data: account } = await admin
      .from('accounts')
      .select('id, company_id')
      .eq('id', accountId)
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

  // Try the Auth admin invite. We use the `auth.admin` API on the
  // service-role client. This is best-effort: if it fails (already exists,
  // SMTP not configured, etc.) we still want to set up the public.users row
  // so the user has the correct role on next sign-in.
  let invitedAuthUserId: string | null = null
  let inviteWarning: string | null = null
  try {
    // Cast to unknown to access auth.admin without a heavy SDK type import.
    const adminAny = admin as unknown as {
      auth: {
        admin: {
          inviteUserByEmail: (
            e: string,
            options?: { data?: Record<string, unknown> },
          ) => Promise<{
            data: { user: { id: string } | null }
            error: { message: string } | null
          }>
        }
      }
    }
    const inviteResult = await adminAny.auth.admin.inviteUserByEmail(email, {
      data: fullName ? { full_name: fullName } : undefined,
    })
    if (inviteResult.error) {
      inviteWarning = inviteResult.error.message
    } else {
      invitedAuthUserId = inviteResult.data.user?.id ?? null
    }
  } catch (err) {
    inviteWarning = err instanceof Error ? err.message : 'Invite call failed'
  }

  // Upsert into public.users. If there's already a row (e.g. invite
  // re-issued, or the auth user was created earlier), update fields.
  // Auth-created rows usually trigger a public.users insert, but we don't
  // assume that — we look up by email and merge.
  const { data: existing } = await admin
    .from('users')
    .select('id, role, company_id, account_id, is_active, full_name')
    .eq('email', email)
    .maybeSingle()

  let userRow: Record<string, unknown> | null = null

  if (existing) {
    // FIX: hostile-takeover guard. If the existing user is already attached
    // to a *different* company, only super_admin can move them. A
    // company_admin must NOT be able to silently steal a user from another
    // company by inviting their email address.
    const existingCompanyId = (existing as { company_id?: string | null }).company_id ?? null
    const callerProfile = await getCurrentUser(gate.userId)
    if (
      existingCompanyId &&
      existingCompanyId !== id &&
      !isSuperAdmin(callerProfile?.role ?? null)
    ) {
      return NextResponse.json(
        {
          error:
            'User belongs to another company. Ask a super_admin to transfer them.',
        },
        { status: 409 },
      )
    }

    const patch: Record<string, unknown> = {
      role,
      company_id: id,
      account_id: accountId,
      is_active: true,
    }
    if (fullName && !existing.full_name) patch.full_name = fullName

    const { data: updated, error: updateErr } = await admin
      .from('users')
      .update(patch)
      .eq('id', (existing as { id: string }).id)
      .select('id, email, full_name, role, company_id, account_id, is_active')
      .single()
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }
    userRow = updated as Record<string, unknown>
  } else {
    // Create the public.users row. If the auth invite returned an id, use
    // it so the rows stay aligned. Otherwise let the DB assign one — the
    // sign-up trigger will reconcile when the user actually accepts.
    const insertPayload: Record<string, unknown> = {
      email,
      full_name: fullName,
      role,
      company_id: id,
      account_id: accountId,
      is_active: true,
    }
    if (invitedAuthUserId) insertPayload.id = invitedAuthUserId

    const { data: inserted, error: insertErr } = await admin
      .from('users')
      .insert(insertPayload)
      .select('id, email, full_name, role, company_id, account_id, is_active')
      .single()
    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 })
    }
    userRow = inserted as Record<string, unknown>
  }

  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'company.user.invite',
      entity_type: 'company',
      entity_id: id,
      details: { email, role, account_id: accountId, invite_warning: inviteWarning },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({
    user: userRow,
    invite_warning: inviteWarning,
  })
}
