/**
 * Detach an account from a company.
 *
 *   POST /api/admin/companies/:id/accounts/:account_id/detach
 *
 * Clears accounts.company_id when the account currently belongs to :id.
 * The users-sync trigger will null out `users.company_id` for any users
 * attached to that account that have no other company linkage.
 *
 * Gate: super_admin OR company_admin of :id.
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
  if (isSuperAdmin(profile.role)) return { ok: true as const, userId: user.id }
  if (isCompanyAdmin(profile.role) && profile.company_id === companyId) {
    return { ok: true as const, userId: user.id }
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

  const { data: account, error: acctErr } = await admin
    .from('accounts')
    .select('id, company_id')
    .eq('id', account_id)
    .maybeSingle()
  if (acctErr) return NextResponse.json({ error: acctErr.message }, { status: 500 })
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  const acct = account as { id: string; company_id: string | null }
  if (acct.company_id !== id) {
    return NextResponse.json(
      { error: 'Account does not belong to this company' },
      { status: 400 },
    )
  }

  const { error: updateErr } = await admin
    .from('accounts')
    .update({ company_id: null })
    .eq('id', account_id)
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'company.account.detach',
      entity_type: 'account',
      entity_id: account_id,
      details: { from_company: id },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ success: true })
}
