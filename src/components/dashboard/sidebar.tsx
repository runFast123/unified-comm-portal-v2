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
  KeyRound,
  GitBranch,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  ChevronRight,
  Plus,
  Bookmark,
} from 'lucide-react'
import { signOut } from '@/lib/auth-actions'
import { useRealtimeMessages } from '@/hooks/useRealtimeMessages'
import type { User, SavedView } from '@/types/database'
import { SavedViewModal, getSavedViewIcon } from '@/components/inbox/saved-view-modal'

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
  { label: 'Routing', href: '/admin/routing', icon: GitBranch },
  { label: 'Integrations', href: '/admin/integrations', icon: KeyRound },
  { label: 'AI Settings', href: '/admin/ai-settings', icon: Brain },
  { label: 'Notifications', href: '/admin/notifications', icon: Bell },
  { label: 'System Health', href: '/admin/health', icon: Activity },
  { label: 'System Logs', href: '/admin/logs', icon: FileText },
  { label: 'Users', href: '/admin/users', icon: UserCog },
]

export function Sidebar({ user, pendingCount, open, onClose }: SidebarProps) {
  const pathname = usePathname()
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('sidebar-collapsed') === 'true'
  })

  // ── Saved views (smart inboxes) ────────────────────────────────────
  const [savedViews, setSavedViews] = useState<SavedView[]>([])
  const [savedViewsOpen, setSavedViewsOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    return localStorage.getItem('sidebar-saved-views-open') !== 'false'
  })
  const [savedViewsLoading, setSavedViewsLoading] = useState(false)
  const [showSavedViewModal, setShowSavedViewModal] = useState(false)

  const fetchSavedViews = useCallback(() => {
    setSavedViewsLoading(true)
    fetch('/api/saved-views')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data?.views)) setSavedViews(data.views as SavedView[])
      })
      .catch(() => {/* silent — section just shows empty + new view */})
      .finally(() => setSavedViewsLoading(false))
  }, [])

  useEffect(() => {
    fetchSavedViews()
    // Refresh whenever the inbox saves/deletes views (custom event from inbox).
    const onChanged = () => fetchSavedViews()
    if (typeof window !== 'undefined') {
      window.addEventListener('saved-views:changed', onChanged)
      return () => window.removeEventListener('saved-views:changed', onChanged)
    }
  }, [fetchSavedViews])

  const toggleSavedViewsOpen = () => {
    const next = !savedViewsOpen
    setSavedViewsOpen(next)
    if (typeof window !== 'undefined') {
      localStorage.setItem('sidebar-saved-views-open', String(next))
    }
  }

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
    `relative flex items-center rounded-lg text-sm font-medium transition-colors ${
      collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3 py-2'
    } ${
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
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex flex-col bg-sidebar border-r border-sidebar-border transition-all duration-200 ease-in-out md:translate-x-0 md:static md:z-auto ${
          collapsed ? 'md:w-[68px] overflow-hidden' : 'md:w-64'
        } w-64 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo / Brand */}
        <div className={`flex h-16 items-center border-b border-sidebar-border ${collapsed ? 'justify-center px-2' : 'justify-between px-4'}`}>
          <Link href="/dashboard" className={`flex items-center ${collapsed ? 'justify-center' : 'gap-3'}`}>
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
            className="md:hidden flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-sidebar-foreground"
            aria-label="Close sidebar"
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
                <span
                  className={`flex items-center justify-center rounded-full bg-red-500 font-semibold text-white ${
                    collapsed
                      ? 'absolute -top-1.5 -right-1.5 h-[18px] min-w-[18px] px-1 text-[10px]'
                      : 'relative h-5 min-w-[20px] px-1.5 text-xs'
                  }`}
                  aria-label={`${pendingCount} pending messages`}
                >
                  {hasNewMessages && (
                    <span className="absolute -inset-1 rounded-full bg-red-400 opacity-75 animate-ping" aria-hidden="true" />
                  )}
                  <span className="relative">{collapsed ? (pendingCount > 9 ? '9+' : pendingCount) : (pendingCount > 99 ? '99+' : pendingCount)}</span>
                </span>
              )}
            </Link>
          ))}

          {/* Saved Views section — collapsible, sits between Inbox and Admin */}
          <div className={collapsed ? 'pt-4 pb-1 px-2' : 'pt-5 pb-1 px-3'}>
            {!collapsed ? (
              <button
                type="button"
                onClick={toggleSavedViewsOpen}
                className="flex w-full items-center justify-between rounded-md px-1 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-sidebar-foreground transition-colors"
                aria-expanded={savedViewsOpen}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Bookmark className="h-3.5 w-3.5" />
                  Saved views
                </span>
                {savedViewsOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
            ) : (
              <div className="border-t border-sidebar-border" />
            )}
          </div>

          {savedViewsOpen && (
            <div className={collapsed ? 'space-y-1' : 'space-y-0.5'}>
              {savedViews.map((sv) => {
                const SVIcon = getSavedViewIcon(sv.icon)
                const href = `/inbox?view=${sv.id}`
                const active = pathname === '/inbox' && typeof window !== 'undefined' &&
                  new URLSearchParams(window.location.search).get('view') === sv.id
                return (
                  <Link
                    key={sv.id}
                    href={href}
                    onClick={onClose}
                    title={collapsed ? sv.name : undefined}
                    className={`relative flex items-center rounded-lg text-sm font-medium transition-colors ${
                      collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-1.5'
                    } ${
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`}
                  >
                    <SVIcon className="h-4 w-4 flex-shrink-0" />
                    {!collapsed && (
                      <span className="flex-1 truncate">{sv.name}</span>
                    )}
                    {!collapsed && sv.is_shared && (
                      <span
                        className="text-[10px] uppercase tracking-wider text-muted-foreground/70"
                        title="Shared with company"
                      >
                        shared
                      </span>
                    )}
                  </Link>
                )
              })}
              {!collapsed && savedViews.length === 0 && !savedViewsLoading && (
                <p className="px-3 py-1 text-xs italic text-muted-foreground">
                  No saved views yet
                </p>
              )}
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => setShowSavedViewModal(true)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  <Plus className="h-4 w-4 flex-shrink-0" />
                  <span>New view</span>
                </button>
              )}
              {collapsed && (
                <button
                  type="button"
                  onClick={() => setShowSavedViewModal(true)}
                  title="New saved view"
                  className="flex w-full items-center justify-center rounded-lg px-2 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  <Plus className="h-4 w-4 flex-shrink-0" />
                </button>
              )}
            </div>
          )}

          {/* Admin Section */}
          {user.role === 'admin' && (
            <>
              <div className={collapsed ? 'pt-4 pb-2 px-2' : 'pt-6 pb-2 px-3'}>
                {!collapsed ? (
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Admin
                  </p>
                ) : (
                  <div className="border-t border-sidebar-border" />
                )}
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

        {/* Keyboard shortcuts hint — matches the KPICard chip style. */}
        {!collapsed && (
          <div className="flex justify-end border-t border-sidebar-border px-3 pt-2 pb-0">
            <button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  window.dispatchEvent(new CustomEvent('shortcuts:open'))
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700 ring-1 ring-teal-200 transition-colors hover:bg-teal-100"
              title="View keyboard shortcuts"
              aria-label="View keyboard shortcuts"
            >
              <kbd className="rounded-md border border-teal-200 bg-white px-1 py-0 text-[10px] font-semibold text-teal-700 shadow-sm">
                ?
              </kbd>
              <span>shortcuts</span>
            </button>
          </div>
        )}

        {/* Collapse toggle — desktop only */}
        <div className="hidden md:flex border-t border-sidebar-border p-2">
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
        <div className={`border-t border-sidebar-border ${collapsed ? 'p-2' : 'p-4'}`}>
          <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-3'}`}>
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
              className={`mt-2 flex w-full items-center rounded-lg text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors ${
                collapsed ? 'justify-center px-2 py-2' : 'gap-2 px-3 py-2'
              }`}
              title={collapsed ? 'Sign out' : undefined}
            >
              <LogOut className="h-4 w-4 shrink-0" />
              {!collapsed && 'Sign out'}
            </button>
          </form>
        </div>
      </aside>

      {/* Saved-view create modal — mounted via portal so it works regardless of sidebar collapse state */}
      <SavedViewModal
        open={showSavedViewModal}
        onClose={() => setShowSavedViewModal(false)}
        onSaved={() => {
          fetchSavedViews()
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('saved-views:changed'))
          }
        }}
      />
    </>
  )
}
