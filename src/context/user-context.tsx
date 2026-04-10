'use client'
import { createContext, useContext, useState, useEffect } from 'react'

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

  // For non-admin users: always fetch sibling accounts via API
  // The server-side layout fetch has proven unreliable (RLS/caching issues)
  useEffect(() => {
    if (user.role === 'admin' || !user.account_id) return

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
    <UserContext.Provider value={{ ...user, isAdmin: user.role === 'admin', companyAccountIds }}>
      {children}
    </UserContext.Provider>
  )
}

export function useUser() {
  return useContext(UserContext)
}
