import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isSuperAdmin } from '@/lib/auth'

/**
 * GET /api/users/search?q=<prefix>
 *
 * Returns up to 10 users from the same company as the requesting user whose
 * `full_name` or `email` starts with `q` (case-insensitive). Used by the
 * @-mention autocomplete in internal notes.
 *
 * Auth: required. Results are scoped to the caller's company so we never leak
 * users across companies. super_admin sees everyone.
 *
 * Returns: `[{ id, full_name, email }]`
 *
 * SECURITY:
 *  - `q` is rejected if it contains PostgREST OR-clause meta characters
 *    (`,`, `(`, `)`) — previously the value was interpolated directly into
 *    `.or()`, allowing crafted strings like `q=foo,id.eq.<UUID>%` to inject
 *    extra OR conditions and exfiltrate arbitrary users.
 *  - Instead of `.or()` we now run two separate parameterised ILIKE queries
 *    (`name` and `email`) and union them in TS — no string interpolation
 *    into the query DSL.
 *  - Legacy `admin` role no longer bypasses company scope; only `super_admin`
 *    sees cross-company users.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const rawQ = (url.searchParams.get('q') || '').trim()
  // Cap query length to avoid abuse — autocomplete only ever sends short strings.
  const q = rawQ.slice(0, 64)

  // SECURITY: reject any character that PostgREST treats as a logical-clause
  // separator. Even though we no longer use .or(), this keeps the contract
  // narrow — autocomplete never sends these.
  if (/[,()]/.test(q)) {
    return NextResponse.json(
      { error: 'q contains forbidden characters' },
      { status: 400 },
    )
  }

  const admin = await createServiceRoleClient()

  // Look up the caller's role + account so we can compute company scope.
  const { data: me } = await admin
    .from('users')
    .select('role, account_id, company_id')
    .eq('id', authUser.id)
    .maybeSingle()

  if (!me) {
    return NextResponse.json({ error: 'User profile not found' }, { status: 404 })
  }

  // Build the prefix-match clause. supabase-js requires us to escape the
  // ILIKE meta-characters so user input can't form wildcards.
  const escaped = q.replace(/[%_\\]/g, '\\$&')
  const ilikePattern = `${escaped}%`

  // Run a query and apply company scoping consistently to it.
  const buildQuery = () => {
    let query = admin
      .from('users')
      .select('id, full_name, email')
      .eq('is_active', true)
      .limit(10)

    // SECURITY: only super_admin bypasses company scope. The legacy `admin`
    // role used to skip this branch entirely — it now flows through the
    // company-scoped path like every other non-super role.
    if (!isSuperAdmin(me.role as string)) {
      const companyId = (me as { company_id?: string | null }).company_id
      if (companyId) {
        // Resolve every account in the same company; restrict results
        // to users assigned to one of those accounts.
        // (Done lazily below in two passes.)
      } else if (me.account_id) {
        // Legacy: caller without company_id but with account_id — restrict
        // to siblings sharing that account_id.
        query = query.eq('account_id', me.account_id)
      } else {
        // Caller with no scope — only see themselves.
        query = query.eq('id', authUser.id)
      }
    }

    return query
  }

  // Resolve the company-account list once, used by both name and email queries.
  let companyAccountIds: string[] | null = null
  if (!isSuperAdmin(me.role as string)) {
    const companyId = (me as { company_id?: string | null }).company_id
    if (companyId) {
      const { data: siblings } = await admin
        .from('accounts')
        .select('id')
        .eq('company_id', companyId)
        .eq('is_active', true)
      companyAccountIds = (siblings || []).map((s: { id: string }) => s.id as string)
      if (companyAccountIds.length === 0) companyAccountIds = [authUser.id] // sentinel "self only"
    }
  }

  const applyCompanyScope = (
    q2: ReturnType<typeof buildQuery>,
  ): ReturnType<typeof buildQuery> => {
    if (companyAccountIds === null) return q2
    if (companyAccountIds.length === 1 && companyAccountIds[0] === authUser.id) {
      // Sentinel — no sibling accounts; restrict to self.
      return q2.eq('id', authUser.id)
    }
    return q2.in('account_id', companyAccountIds)
  }

  // FIX: two separate parameterised queries — no .or() string interpolation.
  let nameRows: Array<{ id: string; full_name: string | null; email: string | null }> = []
  let emailRows: Array<{ id: string; full_name: string | null; email: string | null }> = []

  if (q.length === 0) {
    // Empty query — return the first 10 users in scope.
    const { data, error } = await applyCompanyScope(buildQuery()).order(
      'full_name',
      { ascending: true },
    )
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    nameRows = (data ?? []) as typeof nameRows
  } else {
    const [nameRes, emailRes] = await Promise.all([
      applyCompanyScope(buildQuery())
        .ilike('full_name', ilikePattern)
        .order('full_name', { ascending: true }),
      applyCompanyScope(buildQuery())
        .ilike('email', ilikePattern)
        .order('full_name', { ascending: true }),
    ])
    if (nameRes.error) {
      return NextResponse.json({ error: nameRes.error.message }, { status: 500 })
    }
    if (emailRes.error) {
      return NextResponse.json({ error: emailRes.error.message }, { status: 500 })
    }
    nameRows = (nameRes.data ?? []) as typeof nameRows
    emailRows = (emailRes.data ?? []) as typeof emailRows
  }

  // Union + dedupe by id, take top 10.
  const seen = new Set<string>()
  const merged: typeof nameRows = []
  for (const row of [...nameRows, ...emailRows]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    merged.push(row)
    if (merged.length >= 10) break
  }

  return NextResponse.json({
    users: merged.map((u) => ({
      id: u.id,
      full_name: u.full_name,
      email: u.email,
    })),
  })
}
