'use client'
import { createContext, useContext } from 'react'

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
  // Use server-provided sibling IDs (bypasses RLS), fallback to single account_id
  const companyAccountIds = serverCompanyAccountIds && serverCompanyAccountIds.length > 0
    ? serverCompanyAccountIds
    : user.account_id ? [user.account_id] : []

  return (
    <UserContext.Provider value={{ ...user, isAdmin: user.role === 'admin', companyAccountIds }}>
      {children}
    </UserContext.Provider>
  )
}

export function useUser() {
  return useContext(UserContext)
}
