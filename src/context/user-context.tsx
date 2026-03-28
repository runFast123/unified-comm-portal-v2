'use client'
import { createContext, useContext } from 'react'

interface UserContextType {
  email: string
  full_name: string | null
  role: string
  account_id: string | null
  isAdmin: boolean
}

const UserContext = createContext<UserContextType>({
  email: '',
  full_name: null,
  role: 'viewer',
  account_id: null,
  isAdmin: false,
})

export function UserProvider({ user, children }: { user: Omit<UserContextType, 'isAdmin'>; children: React.ReactNode }) {
  return (
    <UserContext.Provider value={{ ...user, isAdmin: user.role === 'admin' }}>
      {children}
    </UserContext.Provider>
  )
}

export function useUser() {
  return useContext(UserContext)
}
