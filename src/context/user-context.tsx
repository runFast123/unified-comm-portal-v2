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
}

const UserContext = createContext<UserContextType>({
  email: '',
  full_name: null,
  role: 'viewer',
  account_id: null,
  isAdmin: false,
  companyAccountIds: [],
})

export function UserProvider({ user, serverCompanyAccountIds, children }: {
  user: Omit<UserContextType, 'isAdmin' | 'companyAccountIds'>
  serverCompanyAccountIds?: string[]
  children: React.ReactNode
}) {
  // Start with server-provided IDs or single account_id
  const initialIds = serverCompanyAccountIds && serverCompanyAccountIds.length > 0
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
  // thrash state.
  const serverIdsKey = (serverCompanyAccountIds ?? []).join(',')
  useEffect(() => {
    if (serverCompanyAccountIds && serverCompanyAccountIds.length > 0) {
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
        if (data.accountIds && data.accountIds.length > 0) {
          setCompanyAccountIds(data.accountIds)
        }
      })
      .catch(() => { /* keep the initial IDs */ })
  }, [user.role, user.account_id])

  return (
    <UserContext.Provider value={{ ...user, isAdmin: ADMIN_ROLES.has(user.role), companyAccountIds }}>
      {children}
    </UserContext.Provider>
  )
}

export function useUser() {
  return useContext(UserContext)
}
