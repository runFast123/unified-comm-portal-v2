import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import type { UserRole } from '@/types/database'

interface AdminCtx {
  userId: string
  role: string
  companyId: string | null
}

const ROLES: UserRole[] = ['admin', 'company_admin', 'company_member', 'reviewer', 'viewer']

/**
 * Auth gate: caller must be super_admin OR a company-level admin.
 *
 * SECURITY: previously this only accepted the legacy `'admin'` literal,
 * which let any user with that role mutate other users across companies
 * (including reassigning their `account_id` into a different company).
 * We now accept the modern role names AND, for non-super_admin roles,
 * scope mutations to the caller's company in the POST handler below.
 */
async function requireAdmin(): Promise<
  | { ok: true; ctx: AdminCtx }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }

  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role, company_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile?.role) {
    return { ok: false, status: 403, error: 'Admin only' }
  }
  const role = profile.role as string
  if (!isSuperAdmin(role) && !isCompanyAdmin(role)) {
    return { ok: false, status: 403, error: 'Admin only' }
  }
  return {
    ok: true,
    ctx: {
      userId: user.id,
      role,
      companyId: (profile as { company_id?: string | null }).company_id ?? null,
    },
  }
}

interface UpdateBody {
  user_id?: string
  role?: UserRole
  account_id?: string | null
  is_active?: boolean
}

// POST /api/users/update
// Body: { user_id, role?, account_id?, is_active? }
// Admin-only. Updates only the provided fields. Protects against demoting
// the last remaining active admin.
//
// SECURITY (multi-tenant):
//   - For non-super_admin: target user's `company_id` MUST equal caller's
//     company_id, AND any new `account_id` MUST belong to the caller's
//     company. This prevents cross-tenant takeover via either user re-bind
//     or account reassignment.
//   - super_admin can do anything (cross-tenant moves, etc.).
export async function POST(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: UpdateBody
  try {
    body = (await request.json()) as UpdateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { user_id, role, account_id, is_active } = body
  if (!user_id || typeof user_id !== 'string') {
    return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  }

  // Build patch with only provided fields
  const patch: Record<string, unknown> = {}

  if (role !== undefined) {
    if (!ROLES.includes(role)) {
      return NextResponse.json(
        { error: `role must be one of: ${ROLES.join(', ')}` },
        { status: 400 }
      )
    }
    patch.role = role
  }

  if (account_id !== undefined) {
    if (account_id !== null && typeof account_id !== 'string') {
      return NextResponse.json({ error: 'account_id must be a string or null' }, { status: 400 })
    }
    patch.account_id = account_id
  }

  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') {
      return NextResponse.json({ error: 'is_active must be a boolean' }, { status: 400 })
    }
    patch.is_active = is_active
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields provided to update' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()

  // Load the target user
  const { data: target, error: targetErr } = await admin
    .from('users')
    .select('id, email, role, account_id, is_active, company_id')
    .eq('id', user_id)
    .maybeSingle()

  if (targetErr) {
    return NextResponse.json({ error: targetErr.message }, { status: 500 })
  }
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const isSuper = isSuperAdmin(gate.ctx.role)

  // FIX: non-super_admin can ONLY mutate users in their own company.
  if (!isSuper) {
    if (!gate.ctx.companyId) {
      return NextResponse.json(
        { error: 'Forbidden: caller has no company' },
        { status: 403 }
      )
    }
    if ((target as { company_id?: string | null }).company_id !== gate.ctx.companyId) {
      return NextResponse.json(
        { error: 'Forbidden: cross-company access denied' },
        { status: 403 }
      )
    }
  }

  // Validate account_id exists (when non-null) AND, for non-super_admin,
  // belongs to the caller's company.
  if (patch.account_id !== undefined && patch.account_id !== null) {
    const { data: acct, error: acctErr } = await admin
      .from('accounts')
      .select('id, company_id')
      .eq('id', patch.account_id as string)
      .maybeSingle()
    if (acctErr) {
      return NextResponse.json({ error: acctErr.message }, { status: 500 })
    }
    if (!acct) {
      return NextResponse.json({ error: 'account_id does not exist' }, { status: 400 })
    }
    if (!isSuper) {
      if ((acct as { company_id?: string | null }).company_id !== gate.ctx.companyId) {
        return NextResponse.json(
          { error: 'Forbidden: account belongs to a different company' },
          { status: 403 }
        )
      }
    }
  }

  // Safety: prevent demoting or deactivating the last remaining active admin.
  // We treat super_admin/admin/company_admin all as "admin" for the purposes
  // of the last-admin guard so the system can't end up with zero admins.
  const targetIsAdmin = isCompanyAdmin(target.role as string)
  const newRoleIsAdmin = patch.role !== undefined && isCompanyAdmin(patch.role as string)
  const demotingRole = patch.role !== undefined && !newRoleIsAdmin && targetIsAdmin
  const deactivatingAdmin =
    patch.is_active !== undefined && patch.is_active === false && targetIsAdmin && target.is_active
  if (demotingRole || deactivatingAdmin) {
    let countQuery = admin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .in('role', ['admin', 'company_admin'])
      .eq('is_active', true)
    if (!isSuper) {
      countQuery = countQuery.eq('company_id', gate.ctx.companyId)
    }
    const { count, error: countErr } = await countQuery
    if (countErr) {
      return NextResponse.json({ error: countErr.message }, { status: 500 })
    }
    if ((count ?? 0) <= 1 && target.is_active) {
      return NextResponse.json(
        { error: 'Cannot remove the last remaining active admin' },
        { status: 400 }
      )
    }
  }

  // Apply the update via service-role (bypasses RLS)
  const { data: updated, error: updateErr } = await admin
    .from('users')
    .update(patch)
    .eq('id', user_id)
    .select()
    .single()

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  // Audit
  await admin.from('audit_log').insert({
    user_id: gate.ctx.userId,
    action: 'user.update',
    entity_type: 'user',
    entity_id: user_id,
    details: { changed: patch, actor_id: gate.ctx.userId },
  })

  return NextResponse.json({ success: true, user: updated })
}
