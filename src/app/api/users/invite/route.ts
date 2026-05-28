import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'
import type { UserRole } from '@/types/database'

interface AdminCtx {
  userId: string
  role: string
  companyId: string | null
}

// Canonical list of role values accepted by the invite endpoint. The modern
// roles (super_admin/company_admin/supervisor/company_member) are the only
// ones the UI surfaces for new invites, but we still accept the legacy
// admin/reviewer/viewer literals so re-invite and migration flows keep
// working. The `super_admin` literal is only assignable by a super_admin
// caller — enforced below via COMPANY_ADMIN_ASSIGNABLE_ROLES.
const ALL_ROLES: UserRole[] = [
  'super_admin',
  'admin',
  'company_admin',
  'supervisor',
  'company_member',
  'reviewer',
  'viewer',
]

/**
 * Roles a non-super_admin caller is allowed to assign when inviting a new
 * user. company_admin must NOT be able to mint super_admin accounts; we
 * also disallow the legacy `admin` literal so the cross-tenant admin role
 * stays super_admin-only.
 */
const COMPANY_ADMIN_ASSIGNABLE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'company_admin',
  'supervisor',
  'company_member',
  'reviewer',
  'viewer',
])

/**
 * Auth gate: caller must be super_admin OR a company-level admin.
 * Mirrors src/app/api/users/update/route.ts.
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

interface InviteBody {
  email?: string
  full_name?: string | null
  role?: UserRole
  account_id?: string | null
  company_id?: string | null
}

/**
 * POST /api/users/invite
 * Body: { email, full_name?, role, account_id?, company_id? }
 *
 * Pre-registers a user. The client previously did this with a direct
 * `supabase.from('users').insert(...)` which let any caller pick any role
 * (including super_admin) and any account. This endpoint moves the insert
 * server-side so we can enforce:
 *
 *   - caller is super_admin or company_admin (above);
 *   - company_admin can only assign roles from COMPANY_ADMIN_ASSIGNABLE_ROLES
 *     (i.e. not super_admin and not legacy `admin`);
 *   - company_admin can only invite into their own company; super_admin
 *     can pick any company;
 *   - if account_id is provided, it must belong to the resolved company.
 *
 * Returns the new users row.
 */
export async function POST(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: InviteBody
  try {
    body = (await request.json()) as InviteBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 })
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'email is not valid' }, { status: 400 })
  }

  const role = body.role
  if (!role || !ALL_ROLES.includes(role)) {
    return NextResponse.json(
      { error: `role must be one of: ${ALL_ROLES.join(', ')}` },
      { status: 400 }
    )
  }

  const isSuper = isSuperAdmin(gate.ctx.role)

  // company_admin can NOT mint super_admin (or legacy `admin`) accounts.
  if (!isSuper && !COMPANY_ADMIN_ASSIGNABLE_ROLES.has(role)) {
    return NextResponse.json(
      { error: 'Forbidden: company_admin cannot assign this role' },
      { status: 403 }
    )
  }

  // Resolve target company.
  //   super_admin: may pick any company (or null);
  //   company_admin: pinned to their own company_id.
  let targetCompanyId: string | null
  if (isSuper) {
    targetCompanyId =
      body.company_id !== undefined ? body.company_id ?? null : gate.ctx.companyId
  } else {
    if (!gate.ctx.companyId) {
      return NextResponse.json(
        { error: 'Forbidden: caller has no company' },
        { status: 403 }
      )
    }
    if (body.company_id !== undefined && body.company_id !== gate.ctx.companyId) {
      return NextResponse.json(
        { error: 'Forbidden: cross-company invite denied' },
        { status: 403 }
      )
    }
    targetCompanyId = gate.ctx.companyId
  }

  const admin = await createServiceRoleClient()

  // Validate account_id if provided: must exist AND belong to the resolved
  // company (so a company_admin can't bind the new user to another tenant's
  // account by guessing its id).
  const accountId = body.account_id ?? null
  if (accountId !== null) {
    if (typeof accountId !== 'string') {
      return NextResponse.json({ error: 'account_id must be a string or null' }, { status: 400 })
    }
    const { data: acct, error: acctErr } = await admin
      .from('accounts')
      .select('id, company_id')
      .eq('id', accountId)
      .maybeSingle()
    if (acctErr) {
      return NextResponse.json({ error: acctErr.message }, { status: 500 })
    }
    if (!acct) {
      return NextResponse.json({ error: 'account_id does not exist' }, { status: 400 })
    }
    if (
      targetCompanyId !== null &&
      (acct as { company_id?: string | null }).company_id !== targetCompanyId
    ) {
      return NextResponse.json(
        { error: 'account_id belongs to a different company' },
        { status: 400 }
      )
    }
  }

  const fullName =
    typeof body.full_name === 'string' && body.full_name.trim().length > 0
      ? body.full_name.trim()
      : null

  // Insert via service role (bypasses RLS — safe because we've gated above).
  const { data: inserted, error: insertErr } = await admin
    .from('users')
    .insert({
      email,
      full_name: fullName,
      role,
      avatar_url: null,
      is_active: true,
      last_login_at: null,
      account_id: accountId,
      company_id: targetCompanyId,
    })
    .select()
    .single()

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  // Audit
  await admin.from('audit_log').insert({
    user_id: gate.ctx.userId,
    action: 'user.invite',
    entity_type: 'user',
    entity_id: (inserted as { id: string }).id,
    details: {
      email,
      role,
      account_id: accountId,
      company_id: targetCompanyId,
      actor_id: gate.ctx.userId,
    },
  })

  return NextResponse.json({ success: true, user: inserted })
}
