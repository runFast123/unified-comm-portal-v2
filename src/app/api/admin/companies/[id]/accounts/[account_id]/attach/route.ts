/**
 * Attach an account to a company.
 *
 *   POST /api/admin/companies/:id/accounts/:account_id/attach
 *
 * Sets accounts.company_id = :id. The trigger on `users` will reconcile
 * `users.company_id` for any user attached to that account.
 *
 * Gate: super_admin OR company_admin of :id (so they can pull an unassigned
 * account into their tenant). Reassigning an account currently owned by a
 * DIFFERENT company requires super_admin (cross-tenant move).
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isSuperAdmin, isCompanyAdmin } from '@/lib/auth'

async function requireCompanyAdminFor(companyId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const profile = await getCurrentUser(user.id)
  if (!profile) return { ok: false as const, status: 403, error: 'Forbidden' }
  if (isSuperAdmin(profile.role)) return { ok: true as const, userId: user.id, isSuper: true as const }
  if (isCompanyAdmin(profile.role) && profile.company_id === companyId) {
    return { ok: true as const, userId: user.id, isSuper: false as const }
  }
  return { ok: false as const, status: 403, error: 'Forbidden' }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; account_id: string }> },
) {
  const { id, account_id } = await context.params
  const gate = await requireCompanyAdminFor(id)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = await createServiceRoleClient()

  // Verify the company exists.
  const { data: company } = await admin
    .from('companies')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

  // Read current account state.
  const { data: account, error: acctErr } = await admin
    .from('accounts')
    .select('id, company_id, name')
    .eq('id', account_id)
    .maybeSingle()
  if (acctErr) return NextResponse.json({ error: acctErr.message }, { status: 500 })
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  const acct = account as { id: string; company_id: string | null; name: string }

  // Cross-tenant move: only super_admin allowed.
  if (acct.company_id && acct.company_id !== id && !gate.isSuper) {
    return NextResponse.json(
      { error: 'Only a super_admin can move an account between companies' },
      { status: 403 },
    )
  }

  // No-op shortcut.
  if (acct.company_id === id) {
    return NextResponse.json({ success: true, account: acct })
  }

  const { data: updated, error: updateErr } = await admin
    .from('accounts')
    .update({ company_id: id })
    .eq('id', account_id)
    .select('id, name, company_id, channel_type, is_active')
    .single()
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'company.account.attach',
      entity_type: 'account',
      entity_id: account_id,
      details: { from_company: acct.company_id, to_company: id },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ success: true, account: updated })
}
