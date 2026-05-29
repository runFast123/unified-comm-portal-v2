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

  // ── How a user actually comes into existence in this system ──────────────
  // public.users rows are created ONLY by the `handle_new_auth_user` trigger
  // when a Supabase Auth user is created (i.e. on signup). public.users.id
  // has no default — it must equal auth.uid. So we CANNOT insert a free-
  // standing users row here (that was the old bug: "null value in column id").
  //
  // Two cases:
  //   A) The email already belongs to a real user → update that row directly
  //      (role / account / company), with a hostile-takeover guard so a
  //      company_admin can't steal a user from another tenant.
  //   B) The email is not a user yet → store a pending invitation. The signup
  //      trigger consumes it (by email) and applies role/account/company when
  //      the person signs up. This is exactly what the modal promises.

  const { data: existingUser } = await admin
    .from('users')
    .select('id, role, company_id, account_id, full_name')
    .eq('email', email)
    .maybeSingle()

  if (existingUser) {
    const existingCompanyId =
      (existingUser as { company_id?: string | null }).company_id ?? null
    // Hostile-takeover guard: a company_admin must not move a user who's
    // already attached to a different company. Only super_admin can.
    if (!isSuper && existingCompanyId && existingCompanyId !== targetCompanyId) {
      return NextResponse.json(
        {
          error:
            'That email already belongs to a user in another company. Ask a super_admin to transfer them.',
        },
        { status: 409 }
      )
    }

    const patch: Record<string, unknown> = {
      role,
      account_id: accountId,
      company_id: targetCompanyId,
      is_active: true,
    }
    if (fullName && !(existingUser as { full_name?: string | null }).full_name) {
      patch.full_name = fullName
    }

    const { data: updated, error: updateErr } = await admin
      .from('users')
      .update(patch)
      .eq('id', (existingUser as { id: string }).id)
      .select('id, email, full_name, role, company_id, account_id, is_active')
      .single()
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    await admin.from('audit_log').insert({
      user_id: gate.ctx.userId,
      action: 'user.invite.update_existing',
      entity_type: 'user',
      entity_id: (updated as { id: string }).id,
      details: { email, role, account_id: accountId, company_id: targetCompanyId, actor_id: gate.ctx.userId },
    })

    return NextResponse.json({
      success: true,
      status: 'updated',
      message: 'Existing user updated with the new role and assignment.',
      user: updated,
    })
  }

  // Case B — brand-new email. We try, in order:
  //
  //   1. Supabase Auth admin invite — sends a "set your password" email AND
  //      creates the auth user. The `handle_new_auth_user` trigger fires and
  //      makes a public.users row immediately, but with DEFAULT role (the
  //      invitation row doesn't exist at that instant), so we then UPDATE that
  //      row to the intended role/account/company. → email_sent:true.
  //
  //   2. If the invite email can't be sent (SMTP not configured, rate limited,
  //      user already exists in auth, or the call throws) we FALL BACK to the
  //      original behaviour: upsert a pending user_invitations row so the
  //      signup trigger still applies the role when the person self-signs-up,
  //      and hand the admin a shareable signup link. → email_sent:false.

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://project-0stjf.vercel.app'

  // Narrow the service-role client to the admin-invite surface. The runtime
  // object is a full @supabase/supabase-js client (see createServiceRoleClient)
  // which exposes auth.admin.inviteUserByEmail; we type just what we touch.
  const adminAny = admin as unknown as {
    auth: {
      admin: {
        inviteUserByEmail: (
          e: string,
          opts?: { data?: Record<string, unknown>; redirectTo?: string }
        ) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>
      }
    }
  }

  // Capture the (already-narrowed) caller context in a stable local so the
  // closure below doesn't re-trigger the discriminated-union narrowing on
  // `gate` (which TS can't carry across a nested function boundary).
  const ctx = gate.ctx

  // Pre-register fallback (shared by every non-happy path below). Upsert by
  // email so re-inviting just refreshes the pending settings rather than
  // erroring on the PK — identical to the previous Case B behaviour.
  async function preregisterFallback() {
    const { data: invitation, error: inviteErr } = await admin
      .from('user_invitations')
      .upsert(
        {
          email,
          role,
          account_id: accountId,
          company_id: targetCompanyId,
          full_name: fullName,
          invited_by: ctx.userId,
        },
        { onConflict: 'email' }
      )
      .select()
      .single()

    if (inviteErr) {
      return NextResponse.json({ error: inviteErr.message }, { status: 500 })
    }

    await admin.from('audit_log').insert({
      user_id: ctx.userId,
      action: 'user.invite.preregister',
      entity_type: 'user_invitation',
      entity_id: null,
      details: { email, role, account_id: accountId, company_id: targetCompanyId, actor_id: ctx.userId },
    })

    return NextResponse.json({
      success: true,
      status: 'invited',
      email_sent: false,
      signup_url: `${siteUrl}/signup`,
      warning:
        'Invite email could not be sent (email/SMTP not configured in Supabase). Share the signup link with the user — they will inherit this role when they sign up with this email.',
      message: 'User pre-registered.',
      invitation,
    })
  }

  // Step 1 — attempt the auth admin invite. A thrown exception (network, SDK,
  // unexpected shape) must behave exactly like a returned error: fall back.
  let inv: { data: { user: { id: string } | null }; error: { message: string } | null }
  try {
    inv = await adminAny.auth.admin.inviteUserByEmail(email, {
      data: fullName ? { full_name: fullName } : undefined,
      redirectTo: `${siteUrl}/accept-invite`,
    })
  } catch {
    return preregisterFallback()
  }

  // Step 2a — email sent + auth user created. Promote the trigger-created row
  // to the intended values. If this UPDATE fails it's non-fatal: the email is
  // already out and the user exists; we still report success so the admin
  // isn't told the invite failed when it didn't.
  if (!inv.error && inv.data.user?.id) {
    await admin
      .from('users')
      .update({
        role,
        account_id: accountId,
        company_id: targetCompanyId,
        full_name: fullName ?? undefined,
        is_active: true,
      })
      .eq('id', inv.data.user.id)

    await admin.from('audit_log').insert({
      user_id: ctx.userId,
      action: 'user.invite.email',
      entity_type: 'user',
      entity_id: inv.data.user.id,
      details: { email, role, account_id: accountId, company_id: targetCompanyId, actor_id: ctx.userId },
    })

    return NextResponse.json({
      success: true,
      status: 'invited',
      email_sent: true,
      message: `Invite email sent to ${email}.`,
    })
  }

  // Step 2b — inviteUserByEmail returned an error (SMTP missing, rate limited,
  // already-registered auth user, etc.). Fall back to pre-registration.
  return preregisterFallback()
}
