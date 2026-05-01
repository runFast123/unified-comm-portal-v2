import { redirect, notFound } from 'next/navigation'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isSuperAdmin, isCompanyAdmin } from '@/lib/auth'
import { CompanyDetailClient, type CompanyDetailData } from './company-detail-client'

// Force dynamic — joins live data on every request.
export const dynamic = 'force-dynamic'

interface AccountRow {
  id: string
  name: string
  channel_type: string
  is_active: boolean
  company_id: string | null
}

interface UserRow {
  id: string
  email: string
  full_name: string | null
  role: string
  is_active: boolean
  account_id: string | null
  last_login_at: string | null
  created_at: string
}

interface AuditRow {
  id: string
  user_id: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  details: Record<string, unknown> | null
  created_at: string
  actor_email?: string | null
}

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const supabase = await createServerSupabaseClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()
  if (!authUser) redirect('/login')

  const profile = await getCurrentUser(authUser.id)
  if (!profile) redirect('/dashboard')

  const isSuper = isSuperAdmin(profile.role)
  const isAdminOfThis = isCompanyAdmin(profile.role) && profile.company_id === id
  if (!isSuper && !isAdminOfThis) {
    redirect('/dashboard')
  }

  const admin = await createServiceRoleClient()

  // Load the company.
  const { data: companyRow } = await admin
    .from('companies')
    .select(
      'id, name, slug, logo_url, accent_color, monthly_ai_budget_usd, settings, default_email_signature, created_at, updated_at',
    )
    .eq('id', id)
    .maybeSingle()

  if (!companyRow) notFound()

  // Load company accounts.
  const { data: accountsRows } = await admin
    .from('accounts')
    .select('id, name, channel_type, is_active, company_id')
    .eq('company_id', id)
    .order('name', { ascending: true })

  // Load detached accounts (super_admin only — needed for re-attach UI).
  let detachedAccounts: AccountRow[] = []
  if (isSuper) {
    const { data: rows } = await admin
      .from('accounts')
      .select('id, name, channel_type, is_active, company_id')
      .is('company_id', null)
      .order('name', { ascending: true })
    detachedAccounts = (rows as AccountRow[] | null) ?? []
  }

  // Load company users.
  const { data: usersRows } = await admin
    .from('users')
    .select('id, email, full_name, role, is_active, account_id, last_login_at, created_at')
    .eq('company_id', id)
    .order('created_at', { ascending: true })

  // Audit log: last 100 entries scoped to this company. We pull entries
  // where the actor (`user_id`) belongs to this company OR the
  // entity_id refers to one of this company's accounts/users/the company itself.
  const accountIds = ((accountsRows as AccountRow[] | null) ?? []).map((a) => a.id)
  const userIds = ((usersRows as UserRow[] | null) ?? []).map((u) => u.id)

  const auditEntityIds = [id, ...accountIds, ...userIds]

  // We do TWO queries (actor-based + entity-based) and merge in-memory to
  // avoid an OR across large id sets that postgrest doesn't render efficiently.
  const [actorAudit, entityAudit] = await Promise.all([
    userIds.length > 0
      ? admin
          .from('audit_log')
          .select('id, user_id, action, entity_type, entity_id, details, created_at')
          .in('user_id', userIds)
          .order('created_at', { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    admin
      .from('audit_log')
      .select('id, user_id, action, entity_type, entity_id, details, created_at')
      .in('entity_id', auditEntityIds)
      .order('created_at', { ascending: false })
      .limit(100),
  ])

  const auditMap = new Map<string, AuditRow>()
  const auditRows = [
    ...(((actorAudit as { data?: Array<Record<string, unknown>> }).data) ?? []),
    ...(((entityAudit as { data?: Array<Record<string, unknown>> }).data) ?? []),
  ] as unknown as AuditRow[]
  for (const row of auditRows) {
    auditMap.set(row.id, row)
  }
  const auditMerged = Array.from(auditMap.values())
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 100)

  // Resolve actor emails for display (best-effort; missing user → null).
  const actorIds = Array.from(new Set(auditMerged.map((r) => r.user_id).filter(Boolean) as string[]))
  const actorMap: Record<string, string> = {}
  if (actorIds.length > 0) {
    const { data: actors } = await admin
      .from('users')
      .select('id, email')
      .in('id', actorIds)
    for (const a of ((actors as Array<{ id: string; email: string }> | null) ?? [])) {
      actorMap[a.id] = a.email
    }
  }

  const audit = auditMerged.map((r) => ({
    ...r,
    actor_email: r.user_id ? actorMap[r.user_id] ?? null : null,
  }))

  const data: CompanyDetailData = {
    company: companyRow as CompanyDetailData['company'],
    accounts: ((accountsRows as AccountRow[] | null) ?? []),
    detachedAccounts,
    users: ((usersRows as UserRow[] | null) ?? []),
    audit,
    canSuper: isSuper,
  }

  return <CompanyDetailClient data={data} />
}
