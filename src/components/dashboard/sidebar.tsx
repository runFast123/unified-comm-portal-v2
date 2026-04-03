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
  PanelLeftClose,
  PanelLeftOpen,
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
  { label: 'Account Settings', href: '/admin/accounts', icon: Settings },
  { label: 'Channels', href: '/admin/channels', icon: Plug },
  { label: 'AI Settings', href: '/admin/ai-settings', icon: Brain },
  { label: 'Notifications', href: '/admin/notifications', icon: Bell },
  { label: 'System Health', href: '/admin/health', icon: Activity },
  { label: 'Users', href: '/admin/users', icon: UserCog },
]

export function Sidebar({ user, pendingCount, open, onClose }: SidebarProps) {
  const pathname = usePathname()
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('sidebar-collapsed') === 'true'
  })

  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('sidebar-collapsed', String(next))
  }

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
        className={`fixed inset-y-0 left-0 z-50 flex flex-col bg-sidebar border-r border-sidebar-border transition-all duration-200 ease-in-out lg:translate-x-0 lg:static lg:z-auto ${
          collapsed ? 'lg:w-[68px]' : 'lg:w-64'
        } w-64 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo / Brand */}
        <div className="flex h-16 items-center justify-between px-4 border-b border-sidebar-border">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm shrink-0">
              <MessageSquare className="h-5 w-5" />
            </div>
            {!collapsed && (
              <span className="text-lg font-semibold text-sidebar-foreground">
                Unified Comms
              </span>
            )}
          </Link>
          <button
            onClick={onClose}
            className="lg:hidden text-muted-foreground hover:text-sidebar-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1" aria-label="Main navigation">
          {mainNavItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={linkClasses(item.href)}
              aria-current={isActive(item.href) ? 'page' : undefined}
              onClick={onClose}
              title={collapsed ? item.label : undefined}
            >
              <item.icon className="h-5 w-5 flex-shrink-0" />
              {!collapsed && <span className="flex-1">{item.label}</span>}
              {item.badge && pendingCount > 0 && (
                <span className={`relative flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-semibold text-white ${collapsed ? 'absolute -top-1 -right-1 h-4 min-w-[16px] text-[10px]' : ''}`} aria-label={`${pendingCount} pending messages`}>
                  {hasNewMessages && (
                    <span className="absolute -inset-1 rounded-full bg-red-400 opacity-75 animate-ping" aria-hidden="true" />
                  )}
                  <span className="relative">{collapsed ? (pendingCount > 9 ? '9+' : pendingCount) : (pendingCount > 99 ? '99+' : pendingCount)}</span>
                </span>
              )}
            </Link>
          ))}

          {/* Admin Section */}
          {user.role === 'admin' && (
            <>
              <div className="pt-6 pb-2 px-3">
                {!collapsed && (
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Admin
                  </p>
                )}
                {collapsed && <div className="border-t border-sidebar-border" />}
              </div>
              {adminNavItems.map((item) => (
                <Link
                  key={`admin-${item.href}`}
                  href={item.href}
                  className={linkClasses(item.href)}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  onClick={onClose}
                  title={collapsed ? item.label : undefined}
                >
                  <item.icon className="h-5 w-5 flex-shrink-0" />
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              ))}
            </>
          )}
        </nav>

        {/* Collapse toggle — desktop only */}
        <div className="hidden lg:flex border-t border-sidebar-border p-2">
          <button
            onClick={toggleCollapsed}
            className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>

        {/* User Info */}
        <div className="border-t border-sidebar-border p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-medium text-accent-foreground shrink-0">
              {initials}
            </div>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm font-medium text-sidebar-foreground">
                  {user.full_name || 'User'}
                </p>
                <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              </div>
            )}
          </div>
          <form action={signOut}>
            <button
              type="submit"
              className="mt-3 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              title={collapsed ? 'Sign out' : undefined}
            >
              <LogOut className="h-4 w-4 shrink-0" />
              {!collapsed && 'Sign out'}
            </button>
          </form>
        </div>
      </aside>
    </>
  )
}
