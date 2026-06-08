'use client'
import { createContext, useContext, useState, useEffect } from 'react'

// Roles considered "admin" for client-side UI gating purposes. Mirrors the
// server-side `isCompanyAdmin()` helper from `src/lib/auth.ts`. The previous
// `role === 'admin'` literal silently treated super_admin and company_admin
// as plain members, hiding admin-only UI from the very people who should
// see it. This list is the single source of truth on the client.
const ADMIN_ROLES = new Set(['super_admin', 'admin', 'company_admin'])

interface UserContextType {
  email: string
  full_name: string | null
  role: string
  account_id: string | null
  isAdmin: boolean
  /** All account IDs for the same company (email + teams + whatsapp siblings) */
  companyAccountIds: string[]
  /**
   * The active tenant id, or `null` when the super_admin is in
   * "combined view" mode (no tenant selected → cross-tenant queries).
   *
   * Consumers MUST gate the `account_id IN (companyAccountIds)` filter on
   * `activeCompanyId !== null`, NOT on `companyAccountIds.length > 0` —
   * a real tenant with zero accounts should produce ZERO rows (an empty
   * `.in('account_id', [])` returns no rows), but a `null` activeCompanyId
   * means "show everything across all tenants" for super_admin.
   */
  activeCompanyId: string | null
  /** Effective RBAC permission keys for the current user. */
  permissions: string[]
  /** Whether the user holds a permission key (no set provided → ungated → true). */
  can: (permission: string) => boolean
}

const UserContext = createContext<UserContextType>({
  email: '',
  full_name: null,
  role: 'viewer',
  account_id: null,
  isAdmin: false,
  companyAccountIds: [],
  activeCompanyId: null,
  permissions: [],
  can: () => true,
})

export function UserProvider({ user, serverCompanyAccountIds, activeCompanyId = null, permissions, children }: {
  user: Omit<UserContextType, 'isAdmin' | 'companyAccountIds' | 'activeCompanyId' | 'permissions' | 'can'>
  serverCompanyAccountIds?: string[]
  /** Server-resolved active tenant id. `null` = super_admin combined view. */
  activeCompanyId?: string | null
  /** Server-resolved effective permission keys (RBAC). */
  permissions?: string[]
  children: React.ReactNode
}) {
  // Start with server-provided IDs. Use the server value WHEN IT IS DEFINED
  // — even if it's an empty array (a real tenant with zero accounts must
  // scope queries to `[]`, NOT silently fall back to the user's own
  // account_id, which would leak the super_admin's home-tenant data into
  // the zero-account tenant view for the first render). Only fall back to
  // `[user.account_id]` when the prop is `undefined` (the provider being
  // used outside the dashboard layout).
  const initialIds = serverCompanyAccountIds !== undefined
    ? serverCompanyAccountIds
    : user.account_id ? [user.account_id] : []

  const [companyAccountIds, setCompanyAccountIds] = useState<string[]>(initialIds)

  // Sync companyAccountIds when the parent layout passes a NEW
  // serverCompanyAccountIds (e.g. super_admin picked a different tenant in
  // the switcher → router.refresh() → layout re-runs with new cookie →
  // new IDs reach this provider as props). useState only seeds from initial
  // props; without this effect, the context would keep the stale tenant's
  // IDs and downstream useEffects with companyAccountIds in their deps
  // never re-fire — which is exactly the "had to manually refresh" bug.
  // Compare by joined-string key so a new array with same contents doesn't
  // thrash state. We also accept *empty* arrays here — a real tenant with
  // zero accounts must scope queries to `[]` (i.e. "no rows"), NOT keep
  // the previous tenant's IDs.
  const serverIdsKey = (serverCompanyAccountIds ?? []).join(',')
  useEffect(() => {
    if (serverCompanyAccountIds) {
      setCompanyAccountIds(serverCompanyAccountIds)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverIdsKey])

  // For non-admin users: always fetch sibling accounts via API.
  // Admins (any of admin / super_admin / company_admin) can see everything
  // via RLS so they don't need the sibling-account fetch.
  useEffect(() => {
    if (ADMIN_ROLES.has(user.role) || !user.account_id) return

    fetch('/api/user-accounts')
      .then(res => res.json())
      .then(data => {
        // Accept the API response when it's an array — including the empty
        // array case (account got deactivated mid-session, no siblings
        // found). Same logic as the server-prop sync above: empty array
        // must scope queries to `[]`, not retain the stale [account_id].
        if (Array.isArray(data.accountIds)) {
          setCompanyAccountIds(data.accountIds)
        }
      })
      .catch(() => { /* keep the initial IDs */ })
  }, [user.role, user.account_id])

  const perms = permissions ?? []
  // No set provided (provider used outside the dashboard layout) → don't gate.
  const can = (permission: string) => perms.length === 0 || perms.includes(permission)

  return (
    <UserContext.Provider value={{ ...user, isAdmin: ADMIN_ROLES.has(user.role), companyAccountIds, activeCompanyId, permissions: perms, can }}>
      {children}
    </UserContext.Provider>
  )
}

export function useUser() {
  return useContext(UserContext)
}
