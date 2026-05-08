/**
 * Per-company admin API.
 *
 *   GET   /api/admin/companies/:id  → read (super_admin OR company_admin of that company)
 *   PATCH /api/admin/companies/:id  → update editable fields (same gate)
 *
 * Editable fields:
 *   name, slug, logo_url, accent_color, monthly_ai_budget_usd, settings,
 *   default_email_signature.
 *
 * `default_email_signature` writes are also exposed via
 * `/api/admin/companies/:id/signature` (kept for back-compat / focused signature UI).
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isSuperAdmin, isCompanyAdmin } from '@/lib/auth'

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

interface UpdateBody {
  name?: string
  slug?: string | null
  logo_url?: string | null
  accent_color?: string | null
  monthly_ai_budget_usd?: number | null
  settings?: Record<string, unknown> | null
  default_email_signature?: string | null
}

async function requireCompanyAdminFor(companyId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }

  const profile = await getCurrentUser(user.id)
  if (!profile) return { ok: false as const, status: 403, error: 'Forbidden' }

  if (isSuperAdmin(profile.role)) {
    return { ok: true as const, userId: user.id, isSuper: true as const }
  }
  if (isCompanyAdmin(profile.role) && profile.company_id === companyId) {
    return { ok: true as const, userId: user.id, isSuper: false as const }
  }
  return { ok: false as const, status: 403, error: 'Forbidden' }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const gate = await requireCompanyAdminFor(id)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('companies')
    .select(
      'id, name, slug, logo_url, accent_color, monthly_ai_budget_usd, settings, default_email_signature, created_at, updated_at',
    )
    .eq('id', id)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Company not found' }, { status: 404 })
  return NextResponse.json({ company: data })
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const gate = await requireCompanyAdminFor(id)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: UpdateBody
  try {
    body = (await request.json()) as UpdateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}

  if (body.name !== undefined) {
    const trimmed = String(body.name).trim()
    if (!trimmed || trimmed.length > 200) {
      return NextResponse.json({ error: 'name must be 1-200 chars' }, { status: 400 })
    }
    patch.name = trimmed
  }

  if (body.slug !== undefined) {
    if (body.slug === null || body.slug === '') {
      patch.slug = null
    } else {
      const candidate = String(body.slug).trim().toLowerCase()
      if (!SLUG_PATTERN.test(candidate)) {
        return NextResponse.json(
          { error: 'slug must be 1-64 chars of lowercase letters, digits, or dashes' },
          { status: 400 },
        )
      }
      patch.slug = candidate
    }
  }

  if (body.logo_url !== undefined) {
    if (body.logo_url === null || body.logo_url === '') {
      patch.logo_url = null
    } else {
      const url = String(body.logo_url).trim()
      if (url.length > 2048) {
        return NextResponse.json({ error: 'logo_url too long (>2048 chars)' }, { status: 400 })
      }
      // Light validation — accept http(s) absolute URLs or root-relative paths.
      if (!/^(https?:\/\/|\/)/i.test(url)) {
        return NextResponse.json(
          { error: 'logo_url must be an absolute http(s) URL or root-relative path' },
          { status: 400 },
        )
      }
      patch.logo_url = url
    }
  }

  if (body.accent_color !== undefined) {
    if (body.accent_color === null || body.accent_color === '') {
      patch.accent_color = null
    } else {
      const color = String(body.accent_color).trim()
      if (!HEX_COLOR.test(color)) {
        return NextResponse.json(
          { error: 'accent_color must be a hex color (e.g. #0e7490)' },
          { status: 400 },
        )
      }
      patch.accent_color = color
    }
  }

  if (body.monthly_ai_budget_usd !== undefined) {
    if (body.monthly_ai_budget_usd === null) {
      patch.monthly_ai_budget_usd = null
    } else {
      const num = Number(body.monthly_ai_budget_usd)
      if (!Number.isFinite(num) || num < 0 || num > 1_000_000) {
        return NextResponse.json(
          { error: 'monthly_ai_budget_usd must be a non-negative number ≤ 1,000,000' },
          { status: 400 },
        )
      }
      patch.monthly_ai_budget_usd = num
    }
  }

  if (body.settings !== undefined) {
    // M5 fix: previously `body.settings === null` silently wiped the JSONB
    // blob to {}, which let a typo in a frontend save blow away CSAT
    // template, OOO defaults, etc. Treat null as "no change"; require an
    // explicit object to update. Callers that genuinely want to clear can
    // pass `{}`.
    if (body.settings === null) {
      // intentionally leave patch.settings unset → no change
    } else if (typeof body.settings !== 'object' || Array.isArray(body.settings)) {
      return NextResponse.json({ error: 'settings must be an object' }, { status: 400 })
    } else {
      patch.settings = body.settings
    }
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
    patch.default_email_signature = body.default_email_signature
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields provided to update' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()

  // Slug uniqueness (skip when clearing or when caller didn't change slug).
  if (typeof patch.slug === 'string') {
    const { data: clash } = await admin
      .from('companies')
      .select('id')
      .eq('slug', patch.slug as string)
      .maybeSingle()
    if (clash && (clash as { id: string }).id !== id) {
      return NextResponse.json({ error: 'slug already in use' }, { status: 409 })
    }
  }

  const { data: updated, error: updateErr } = await admin
    .from('companies')
    .update(patch)
    .eq('id', id)
    .select(
      'id, name, slug, logo_url, accent_color, monthly_ai_budget_usd, settings, default_email_signature, created_at, updated_at',
    )
    .single()

  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? 'Failed to update company' },
      { status: 500 },
    )
  }

  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'company.update',
      entity_type: 'company',
      entity_id: id,
      details: { changed: Object.keys(patch) },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ company: updated })
}

/**
 * DELETE /api/admin/companies/:id — super_admin ONLY.
 *
 * This is destructive: dropping a company cascades through accounts,
 * conversations, messages, contacts, etc., via the FK ON DELETE CASCADE
 * chain. To prevent accidents we require:
 *   1. Caller is super_admin (NOT just company_admin of the target).
 *   2. ?confirm=<company-name> query param matches the company's actual
 *      name. This is the same pattern GitHub uses for "delete repo".
 *
 * Safety guards (refuse delete unless explicitly forced):
 *   - If the company has any accounts, return 409 with a list — caller
 *     must detach them first via /accounts/[id]/detach. Add ?force=true
 *     to override (super_admin can still bypass when needed).
 *
 * Audit row written before the delete so the record survives the cascade.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const url = new URL(request.url)
  const confirmName = url.searchParams.get('confirm')
  const force = url.searchParams.get('force') === 'true'

  // Auth: super_admin only — even company_admin of the target can't delete
  // their own company (would lock themselves out). Force them to ask
  // platform staff.
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const profile = await getCurrentUser(user.id)
  if (!profile || !isSuperAdmin(profile.role)) {
    return NextResponse.json(
      { error: 'Only super_admin can delete companies' },
      { status: 403 },
    )
  }

  const admin = await createServiceRoleClient()

  // Look up the company first so we can:
  //   (a) verify it exists,
  //   (b) compare confirm-by-name token,
  //   (c) include the name in the audit log even after the row is gone.
  const { data: company, error: lookupErr } = await admin
    .from('companies')
    .select('id, name')
    .eq('id', id)
    .maybeSingle()
  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  }
  if (!company) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 })
  }

  // Confirm-by-name guard. The frontend must echo the actual company name
  // back as ?confirm=<name>. Catches "wrong company id" mistakes — the
  // most common cause of accidental destructive admin operations.
  if (confirmName == null || confirmName !== company.name) {
    return NextResponse.json(
      {
        error: `Confirmation mismatch — pass ?confirm=<company name> matching "${company.name}"`,
      },
      { status: 400 },
    )
  }

  // Safety: refuse if accounts are still attached, unless force=true.
  // Keeping the explicit detach step in normal flows means the operator
  // sees what they're nuking before they do it.
  const { count: attachedAccounts } = await admin
    .from('accounts')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', id)

  if ((attachedAccounts ?? 0) > 0 && !force) {
    return NextResponse.json(
      {
        error: `Company has ${attachedAccounts} attached account(s). Detach them first or pass ?force=true to cascade delete.`,
        attached_accounts: attachedAccounts,
      },
      { status: 409 },
    )
  }

  // When force=true we need to manually cascade attached accounts and
  // users. The FK behaviors are:
  //   accounts.company_id  → ON DELETE SET NULL
  //   users.company_id     → ON DELETE SET NULL
  // Without an explicit cascade, "force delete" left orphan accounts
  // (company_id=null, is_active untouched) and orphan users (also
  // company_id=null) hanging around in /admin/accounts and /admin/users
  // after the company itself was gone — that's the QA finding M-9.
  //
  // We hard-delete accounts first; the FKs on messages/conversations/
  // channel_configs already CASCADE off accounts.id, so the rest of
  // the tree disappears in one round-trip per child table.
  // attachedAccounts ids snapshot so we can audit individual deletes.
  let attachedAccountIds: string[] = []
  let attachedUserIds: string[] = []
  if (force && (attachedAccounts ?? 0) > 0) {
    const { data: accRows } = await admin
      .from('accounts')
      .select('id')
      .eq('company_id', id)
    attachedAccountIds = (accRows ?? []).map((r) => r.id as string)

    const { data: userRows } = await admin
      .from('users')
      .select('id')
      .eq('company_id', id)
    attachedUserIds = (userRows ?? []).map((r) => r.id as string)
  }

  // Audit BEFORE the delete — once the company is gone the FK on the
  // user (gate.userId) still resolves but the entity_id no longer points
  // to a row, so we keep the snapshot in `details`.
  try {
    await admin.from('audit_log').insert({
      user_id: user.id,
      action: 'company.delete',
      entity_type: 'company',
      entity_id: id,
      details: {
        deleted_company_name: company.name,
        attached_accounts_at_delete: attachedAccounts ?? 0,
        cascaded_account_ids: attachedAccountIds,
        cascaded_user_ids: attachedUserIds,
        force,
      },
    })
  } catch { /* non-fatal — don't block delete on audit write */ }

  // Cascade-delete attached accounts (force=true only). This in turn
  // cascades messages/conversations/channel_configs via their FKs.
  if (force && attachedAccountIds.length > 0) {
    const { error: accDelErr } = await admin
      .from('accounts')
      .delete()
      .in('id', attachedAccountIds)
    if (accDelErr) {
      return NextResponse.json(
        { error: `Failed to cascade-delete attached accounts: ${accDelErr.message}` },
        { status: 500 },
      )
    }
  }

  const { error: deleteErr } = await admin
    .from('companies')
    .delete()
    .eq('id', id)
  if (deleteErr) {
    return NextResponse.json({ error: deleteErr.message }, { status: 500 })
  }

  // Users still exist after the company is gone (FK was SET NULL); the
  // operator can decide whether to reassign or remove them. We leave
  // them in place because deleting auth.users is a heavier operation
  // than this endpoint should own.
  return NextResponse.json({
    ok: true,
    deleted: { id, name: company.name },
    cascaded: force ? { accounts: attachedAccountIds.length, users_detached: attachedUserIds.length } : undefined,
  })
}
