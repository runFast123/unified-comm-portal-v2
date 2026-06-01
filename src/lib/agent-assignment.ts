// --- Round-robin Agent Assignment ---
// Picks the next agent to assign a new conversation to. Used by the routing
// engine when a rule says `use_round_robin = true` (or anywhere callers want
// a "least-loaded next agent" without writing the same boilerplate).
//
// Concurrency model: `assignment_state` has `scope` as PRIMARY KEY. Two
// concurrent webhook calls both calling `pickNextAgent({account_id: X})` for
// the same account will both compute the next agent off the same
// `last_assigned_user_id` snapshot, then both upsert. Worst case both pick
// the same agent (instead of one picking N+1 and the other N+2). Acceptable
// for round-robin: the load metric (open conversations) will shift one tick
// next time and re-balance. Never duplicates or drops assignments.
//
// "No candidates" → return null. Callers should treat null as "leave
// `assigned_to` unchanged" rather than clobbering an existing assignee.

import { createServiceRoleClient } from '@/lib/supabase-server'
import { isCompanyAdmin, COMPANY_ADMIN_ROLE_NAMES } from '@/lib/roles'

interface AgentRow {
  id: string
  role: string
  is_active: boolean
  account_id: string | null
}

interface PickScope {
  account_id?: string
  team?: string
}

function scopeKey(scope: PickScope): string | null {
  if (scope.team) return `team:${scope.team}`
  if (scope.account_id) return `account:${scope.account_id}`
  return null
}

/**
 * Build the candidate pool of agents that could receive an assignment.
 *
 * Team-scoped pool:
 *   The `users` table currently has no `team` column, so "team membership"
 *   cannot be enforced strictly. Fallback strategy:
 *     1. All non-admin active users in the requesting account's company.
 *     2. If that set is empty, fall back to all active company admins.
 *   When a `team` column is added to `users` later, swap step (1) for an
 *   `eq('team', scope.team)` filter.
 *
 * Account-scoped pool:
 *   All active users in the account's company. Membership is keyed on
 *   `company_id`, NOT `account_id`: company membership grants access to every
 *   account in the company, so agents typically have `company_id` set and
 *   `account_id = null` (see getAllowedAccountIds in src/lib/auth.ts).
 *   Accounts with no company fall back to a plain `account_id` match (legacy
 *   single-account tenants).
 */
async function fetchCandidatePool(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  scope: PickScope
): Promise<AgentRow[]> {
  // First: resolve the account to its company. Company membership — not
  // account membership — is what grants an agent access to an account's
  // conversations, so the company id is the primary key for finding
  // candidates. Accounts with no company are legacy single-account tenants.
  let companyId: string | null = null
  let accountIds: string[] = []
  if (scope.account_id) {
    const { data: acctRow } = await supabase
      .from('accounts')
      .select('company_id')
      .eq('id', scope.account_id)
      .maybeSingle()

    companyId = (acctRow?.company_id as string | null | undefined) ?? null
    if (!companyId) accountIds = [scope.account_id]
  }

  // Pull active candidate users.
  //
  // Prefer company_id: company membership spans ALL of a company's accounts,
  // so agents typically have company_id set and account_id = null. Filtering
  // by account_id — as this did originally — silently misses every
  // company-scoped agent and leaves the pool empty, so round-robin assigns no
  // one. Fall back to account_id only for tenants whose account has no company.
  let users: AgentRow[] = []
  if (companyId) {
    const { data } = await supabase
      .from('users')
      .select('id, role, is_active, account_id')
      .eq('company_id', companyId)
      .eq('is_active', true)
    users = (data || []) as AgentRow[]
  } else if (accountIds.length > 0) {
    const { data } = await supabase
      .from('users')
      .select('id, role, is_active, account_id')
      .in('account_id', accountIds)
      .eq('is_active', true)
    users = (data || []) as AgentRow[]
  }

  // Team scope: filter to non-admins from the company pool. If empty,
  // fall back to company admins (any account) so an unconfigured team still
  // gets someone responsible. Both predicates source their role set from
  // src/lib/roles.ts so modern (company_admin) and legacy (admin) names both
  // resolve — hard-coding 'admin' here meant the fallback found nobody on
  // tenants that use the modern role names.
  if (scope.team) {
    const nonAdmins = users.filter((u) => !isCompanyAdmin(u.role))
    if (nonAdmins.length > 0) return nonAdmins

    const { data: admins } = await supabase
      .from('users')
      .select('id, role, is_active, account_id')
      .in('role', [...COMPANY_ADMIN_ROLE_NAMES])
      .eq('is_active', true)
    return (admins || []) as AgentRow[]
  }

  // Account scope: any active user on the account/company.
  return users
}

/**
 * Count open conversations per user in `userIds`. Returns a Map of user_id
 * → open count. Users with zero open conversations won't appear in the map
 * (treat absence as 0).
 *
 * "Open" = not in {resolved, archived}.
 */
async function fetchOpenLoad(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  userIds: string[]
): Promise<Map<string, number>> {
  const loads = new Map<string, number>()
  if (userIds.length === 0) return loads

  const { data } = await supabase
    .from('conversations')
    .select('assigned_to')
    .in('assigned_to', userIds)
    .not('status', 'in', '("resolved","archived")')

  for (const row of data || []) {
    const uid = (row as { assigned_to: string | null }).assigned_to
    if (!uid) continue
    loads.set(uid, (loads.get(uid) || 0) + 1)
  }
  return loads
}

/**
 * Pick the next agent for round-robin assignment.
 *
 * Strategy:
 *   1. Build candidate pool (see fetchCandidatePool).
 *   2. Sort by current open-conversation count ASC, then user_id ASC for
 *      a stable tie-break.
 *   3. Read the last-assigned user from `assignment_state` for this scope.
 *   4. Pick the next user AFTER that one in the sorted list (wrap to start
 *      if not found / pointer at end). This achieves round-robin within
 *      the least-loaded tier.
 *   5. Upsert `assignment_state` with the new pick.
 *
 * Returns the chosen user_id, or null if the pool is empty.
 */
export async function pickNextAgent(scope: PickScope): Promise<string | null> {
  const key = scopeKey(scope)
  if (!key) return null

  const supabase = await createServiceRoleClient()
  const pool = await fetchCandidatePool(supabase, scope)
  if (pool.length === 0) return null

  const userIds = pool.map((u) => u.id)
  const loads = await fetchOpenLoad(supabase, userIds)

  // Sort: least loaded first, then alphabetical.
  const sorted = [...pool].sort((a, b) => {
    const la = loads.get(a.id) || 0
    const lb = loads.get(b.id) || 0
    if (la !== lb) return la - lb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  // Read last assignment pointer.
  const { data: stateRow } = await supabase
    .from('assignment_state')
    .select('last_assigned_user_id')
    .eq('scope', key)
    .maybeSingle()

  const lastId: string | null = stateRow?.last_assigned_user_id || null
  let nextIndex = 0
  if (lastId) {
    const lastIdx = sorted.findIndex((u) => u.id === lastId)
    if (lastIdx >= 0) {
      nextIndex = (lastIdx + 1) % sorted.length
    }
    // If lastId no longer in pool (user deactivated), pick from index 0.
  }

  const picked = sorted[nextIndex]
  if (!picked) return null

  // Upsert the new pointer. PRIMARY KEY on `scope` makes this idempotent.
  // Concurrent calls might both write — the last write wins, which is fine
  // for round-robin (worst case: a single agent gets the same pick twice
  // in flight; the next call rebalances).
  await supabase
    .from('assignment_state')
    .upsert(
      {
        scope: key,
        last_assigned_user_id: picked.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'scope' }
    )

  return picked.id
}
