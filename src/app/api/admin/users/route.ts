/**
 * Admin Users listing API.
 *
 *   GET /api/admin/users
 *
 * Returns users visible to the caller:
 *   - super_admin: returns ALL users across every company. (Optional
 *     ?company_id=<uuid> narrows to one company, used by the company
 *     switcher when a super_admin picks an active tenant.)
 *   - company_admin / admin: returns ONLY users in the caller's company.
 *   - everyone else: 403.
 *
 * Uses the service-role client so super_admin bypasses RLS — the same
 * pattern as /api/admin/companies. Privilege gating happens in TS via
 * isSuperAdmin / isCompanyAdmin.
 */

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

export async function GET(request: Request) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const profile = await getCurrentUser(user.id)
  if (!isSuperAdmin(profile?.role) && !isCompanyAdmin(profile?.role)) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const url = new URL(request.url)
  const queryCompanyId = url.searchParams.get('company_id')

  const admin = await createServiceRoleClient()
  let query = admin
    .from('users')
    .select('*')
    .order('created_at', { ascending: true })

  if (isSuperAdmin(profile?.role)) {
    // super_admin sees everything by default. Honor an explicit ?company_id=
    // query param OR the company-switcher cookie if one is set.
    let scopeCompanyId: string | null = null
    if (queryCompanyId && queryCompanyId.trim().length > 0) {
      scopeCompanyId = queryCompanyId.trim()
    } else {
      const cookieStore = await cookies()
      const cookieCompanyId = cookieStore.get('selected_company_id')?.value ?? null
      if (cookieCompanyId && cookieCompanyId.trim().length > 0) {
        scopeCompanyId = cookieCompanyId.trim()
      }
    }
    if (scopeCompanyId) {
      query = query.eq('company_id', scopeCompanyId)
    }
  } else {
    // company_admin / legacy admin: pinned to their own company. If they
    // somehow have no company, return an empty set (rather than leaking
    // cross-tenant rows).
    if (!profile?.company_id) {
      return NextResponse.json({ users: [] })
    }
    query = query.eq('company_id', profile.company_id)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Pending pre-registrations (people invited but not yet signed up). Scope
  // them the same way as the users list so the admin sees the result of an
  // "Add User" action even though no public.users row exists yet.
  let invQuery = admin
    .from('user_invitations')
    .select('email, role, account_id, company_id, full_name, created_at')
    .order('created_at', { ascending: true })

  if (isSuperAdmin(profile?.role)) {
    let scopeCompanyId: string | null = null
    if (queryCompanyId && queryCompanyId.trim().length > 0) {
      scopeCompanyId = queryCompanyId.trim()
    } else {
      const cookieStore = await cookies()
      const cookieCompanyId = cookieStore.get('selected_company_id')?.value ?? null
      if (cookieCompanyId && cookieCompanyId.trim().length > 0) scopeCompanyId = cookieCompanyId.trim()
    }
    if (scopeCompanyId) invQuery = invQuery.eq('company_id', scopeCompanyId)
  } else if (profile?.company_id) {
    invQuery = invQuery.eq('company_id', profile.company_id)
  }

  const { data: invitations } = await invQuery

  // Companies list for the Add User modal. A super_admin can place a new user
  // into ANY company, so they get the full list; a company_admin is pinned to
  // their own company server-side but we still return it (label display).
  let companies: Array<{ id: string; name: string }> = []
  if (isSuperAdmin(profile?.role)) {
    const { data: comps } = await admin
      .from('companies')
      .select('id, name')
      .order('name', { ascending: true })
    companies = (comps as Array<{ id: string; name: string }> | null) ?? []
  } else if (profile?.company_id) {
    const { data: comps } = await admin
      .from('companies')
      .select('id, name')
      .eq('id', profile.company_id)
    companies = (comps as Array<{ id: string; name: string }> | null) ?? []
  }

  return NextResponse.json({ users: data ?? [], invitations: invitations ?? [], companies })
}
