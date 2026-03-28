'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Inbox,
  Users,
  BarChart3,
  UserCircle,
  BookOpen,
  Settings,
  Plug,
  Sheet,
  Brain,
  Bell,
  Activity,
  UserCog,
  LogOut,
  MessageSquare,
  FileText,
  X,
} from 'lucide-react'
import { signOut } from '@/lib/auth-actions'
import { useRealtimeMessages } from '@/hooks/useRealtimeMessages'
import type { User } from '@/types/database'

interface SidebarProps {
  user: Pick<User, 'email' | 'full_name' | 'role' | 'account_id'>
  pendingCount: number
  open?: boolean
  onClose?: () => void
}

const mainNavItems = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Inbox', href: '/inbox', icon: Inbox, badge: true },
  { label: 'Accounts', href: '/accounts', icon: Users },
  { label: 'Reports', href: '/reports', icon: BarChart3 },
  { label: 'Contacts', href: '/contacts', icon: UserCircle },
  { label: 'Knowledge Base', href: '/knowledge-base', icon: BookOpen },
  { label: 'Templates', href: '/templates', icon: FileText },
  { label: 'Sheets Sync', href: '/sheets', icon: Sheet },
]

const adminNavItems = [
  { label: 'Accounts', href: '/admin/accounts', icon: Settings },
  { label: 'Channels', href: '/admin/channels', icon: Plug },
  { label: 'AI Settings', href: '/admin/ai-settings', icon: Brain },
  { label: 'Notifications', href: '/admin/notifications', icon: Bell },
  { label: 'System Health', href: '/admin/health', icon: Activity },
  { label: 'Users', href: '/admin/users', icon: UserCog },
]

export function Sidebar({ user, pendingCount, open, onClose }: SidebarProps) {
  const pathname = usePathname()
  const [hasNewMessages, setHasNewMessages] = useState(false)

  // Subscribe to realtime messages for badge pulse
  useRealtimeMessages({
    onNewMessage: useCallback(() => {
      setHasNewMessages(true)
    }, []),
  })

  // Clear the pulse when user navigates to inbox
  useEffect(() => {
    if (pathname === '/inbox') {
      setHasNewMessages(false)
    }
  }, [pathname])

  const isActive = (href: string) => {
    if (href === '/dashboard') return pathname === '/dashboard'
    return pathname.startsWith(href)
  }

  const linkClasses = (href: string) =>
    `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      isActive(href)
        ? 'bg-primary text-primary-foreground'
        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
    }`

  const initials = user.full_name
    ? user.full_name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : user.email[0].toUpperCase()

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-sidebar border-r border-sidebar-border transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static lg:z-auto ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo / Brand */}
        <div className="flex h-16 items-center justify-between px-4 border-b border-sidebar-border">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
              <MessageSquare className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold text-sidebar-foreground">
              Unified Comms
            </span>
          </Link>
          <button
            onClick={onClose}
            className="lg:hidden text-muted-foreground hover:text-sidebar-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {mainNavItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={linkClasses(item.href)}
              onClick={onClose}
            >
              <item.icon className="h-5 w-5 flex-shrink-0" />
              <span className="flex-1">{item.label}</span>
              {item.badge && pendingCount > 0 && (
                <span className="relative flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-semibold text-white">
                  {hasNewMessages && (
                    <span className="absolute -inset-1 rounded-full bg-red-400 opacity-75 animate-ping" />
                  )}
                  <span className="relative">{pendingCount > 99 ? '99+' : pendingCount}</span>
                </span>
              )}
            </Link>
          ))}

          {/* Admin Section */}
          {user.role === 'admin' && (
            <>
              <div className="pt-6 pb-2 px-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Admin
                </p>
              </div>
              {adminNavItems.map((item) => (
                <Link
                  key={`admin-${item.href}`}
                  href={item.href}
                  className={linkClasses(item.href)}
                  onClick={onClose}
                >
                  <item.icon className="h-5 w-5 flex-shrink-0" />
                  <span>{item.label}</span>
                </Link>
              ))}
            </>
          )}
        </nav>

        {/* User Info */}
        <div className="border-t border-sidebar-border p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-medium text-accent-foreground">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-medium text-sidebar-foreground">
                {user.full_name || 'User'}
              </p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </div>
          </div>
          <form action={signOut}>
            <button
              type="submit"
              className="mt-3 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  )
}
