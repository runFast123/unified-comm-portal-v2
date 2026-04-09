'use client'

import { useState, useEffect, useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ChevronRight,
  Home,
  RefreshCw,
  LayoutDashboard,
  Inbox,
  Users,
  BarChart3,
  MoreHorizontal,
  BookOpen,
  Settings,
  Plug,
  Sheet,
  Brain,
  Bell as BellIcon,
  Activity,
  UserCog,
  X,
} from 'lucide-react'
import { Sidebar } from '@/components/dashboard/sidebar'
import { NotificationCenter } from '@/components/dashboard/notification-center'
import { GlobalSearch } from '@/components/dashboard/global-search'
import { CommandPalette } from '@/components/ui/command-palette'
import { KeyboardShortcuts } from '@/components/ui/keyboard-shortcuts'
import { UserProvider } from '@/context/user-context'
import type { User } from '@/types/database'

interface DashboardShellProps {
  user: Pick<User, 'email' | 'full_name' | 'role' | 'account_id'>
  pendingCount: number
  companyAccountIds?: string[]
  children: React.ReactNode
}

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/inbox': 'Unified Inbox',
  '/accounts': 'Accounts',
  '/reports': 'Reports & Analytics',
  '/knowledge-base': 'Knowledge Base',
  '/admin/accounts': 'Account Management',
  '/admin/channels': 'Channel Configuration',
  '/admin/sheets': 'Sheets Sync',
  '/admin/ai-settings': 'AI Settings',
  '/admin/notifications': 'Notifications',
  '/admin/health': 'System Health',
  '/admin/users': 'User Management',
}

const mobileNavItems = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Inbox', href: '/inbox', icon: Inbox },
  { label: 'Accounts', href: '/accounts', icon: Users },
  { label: 'Reports', href: '/reports', icon: BarChart3 },
]

const moreNavItems = [
  { label: 'Knowledge Base', href: '/knowledge-base', icon: BookOpen },
  { label: 'Admin Accounts', href: '/admin/accounts', icon: Settings },
  { label: 'Channels', href: '/admin/channels', icon: Plug },
  { label: 'Sheets Sync', href: '/admin/sheets', icon: Sheet },
  { label: 'AI Settings', href: '/admin/ai-settings', icon: Brain },
  { label: 'Notifications', href: '/admin/notifications', icon: BellIcon },
  { label: 'System Health', href: '/admin/health', icon: Activity },
  { label: 'Users', href: '/admin/users', icon: UserCog },
]

function getBreadcrumbs(pathname: string) {
  const segments = pathname.split('/').filter(Boolean)
  const crumbs: { label: string; href: string }[] = []

  if (segments[0] === 'admin' && segments.length > 1) {
    crumbs.push({ label: 'Admin', href: '/admin' })
    const fullPath = '/' + segments.join('/')
    crumbs.push({ label: PAGE_TITLES[fullPath] || segments[segments.length - 1], href: fullPath })
  } else if (segments[0] === 'accounts' && segments.length > 1) {
    crumbs.push({ label: 'Accounts', href: '/accounts' })
    crumbs.push({ label: 'Account Detail', href: pathname })
  } else if (segments[0] === 'conversations' && segments.length > 1) {
    crumbs.push({ label: 'Inbox', href: '/inbox' })
    crumbs.push({ label: 'Conversation', href: pathname })
  } else {
    const fullPath = '/' + segments.join('/')
    crumbs.push({ label: PAGE_TITLES[fullPath] || segments[0] || 'Dashboard', href: fullPath })
  }

  return crumbs
}

// Navigation shortcut map (g + <key>)
const NAV_SHORTCUTS: Record<string, string> = {
  i: '/inbox',
  d: '/dashboard',
  a: '/accounts',
  r: '/reports',
  k: '/knowledge-base',
}

export function DashboardShell({ user, pendingCount, companyAccountIds, children }: DashboardShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [moreSheetOpen, setMoreSheetOpen] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
  const breadcrumbs = getBreadcrumbs(pathname)
  const currentPage = breadcrumbs[breadcrumbs.length - 1]?.label || 'Dashboard'

  const isMobileNavActive = (href: string) => {
    if (href === '/dashboard') return pathname === '/dashboard'
    return pathname.startsWith(href)
  }

  // Global keyboard listeners
  const handleGlobalKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable

      // Cmd/Ctrl+K: handled by GlobalSearch component
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        return
      }

      // Skip remaining shortcuts when typing in inputs
      if (isInput) return

      // ?: keyboard shortcuts
      if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        setShortcutsOpen((prev) => !prev)
        return
      }
    },
    []
  )

  // Navigation shortcuts: g then <key>
  useEffect(() => {
    let gPressed = false
    let gTimer: ReturnType<typeof setTimeout> | null = null

    const handleNavShortcut = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      if (isInput) return

      if (e.key === 'g' && !e.metaKey && !e.ctrlKey) {
        gPressed = true
        if (gTimer) clearTimeout(gTimer)
        gTimer = setTimeout(() => {
          gPressed = false
        }, 800)
        return
      }

      if (gPressed && NAV_SHORTCUTS[e.key]) {
        e.preventDefault()
        gPressed = false
        if (gTimer) clearTimeout(gTimer)
        router.push(NAV_SHORTCUTS[e.key])
      }
    }

    document.addEventListener('keydown', handleNavShortcut)
    return () => {
      document.removeEventListener('keydown', handleNavShortcut)
      if (gTimer) clearTimeout(gTimer)
    }
  }, [router])

  useEffect(() => {
    document.addEventListener('keydown', handleGlobalKeyDown)
    return () => document.removeEventListener('keydown', handleGlobalKeyDown)
  }, [handleGlobalKeyDown])

  return (
    <UserProvider user={user} serverCompanyAccountIds={companyAccountIds}>
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        user={user}
        pendingCount={pendingCount}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile header with hamburger */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-card/95 backdrop-blur-sm px-4 shadow-sm lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-all duration-200"
            aria-label="Open sidebar"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
              />
            </svg>
          </button>
          <span className="text-base font-semibold text-foreground tracking-tight">
            {currentPage}
          </span>
          <div className="flex-1" />
          <NotificationCenter />
          <GlobalSearch variant="mobile" />
          <button
            onClick={() => window.location.reload()}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-label="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </header>

        {/* Desktop breadcrumb bar */}
        <div className="hidden lg:flex items-center justify-between border-b border-border bg-card/80 backdrop-blur-sm px-8 py-2.5">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
            <Link
              href="/dashboard"
              className="text-muted-foreground hover:text-primary transition-colors"
            >
              <Home className="h-4 w-4" />
            </Link>
            {breadcrumbs.map((crumb, i) => (
              <span key={crumb.href} className="flex items-center gap-1.5">
                <ChevronRight className="h-3.5 w-3.5 text-gray-300" />
                {i === breadcrumbs.length - 1 ? (
                  <span className="font-medium text-foreground">{crumb.label}</span>
                ) : (
                  <Link
                    href={crumb.href}
                    className="text-muted-foreground hover:text-primary transition-colors"
                  >
                    {crumb.label}
                  </Link>
                )}
              </span>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <NotificationCenter />
            {/* Global Search */}
            <GlobalSearch />
            <span className="text-xs text-muted-foreground">
              {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </span>
          </div>
        </div>

        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 pb-24 lg:pb-8 bg-background text-foreground" data-page-transition>
          {children}
        </main>
      </div>

      {/* Command Palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />

      {/* Keyboard Shortcuts */}
      <KeyboardShortcuts
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      {/* Mobile Bottom Navigation - visible only on small screens */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around border-t border-border bg-card px-2 py-1.5 shadow-[0_-2px_10px_rgba(0,0,0,0.05)] lg:hidden">
        {mobileNavItems.map((item) => {
          const active = isMobileNavActive(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg text-[11px] font-medium transition-colors min-w-[44px] min-h-[44px] justify-center ${
                active
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <item.icon className="h-5 w-5" />
              <span>{item.label}</span>
            </Link>
          )
        })}
        <button
          onClick={() => setMoreSheetOpen(true)}
          className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors min-w-[44px] min-h-[44px] justify-center"
        >
          <MoreHorizontal className="h-5 w-5" />
          <span>More</span>
        </button>
      </nav>

      {/* More Sheet (mobile) */}
      {moreSheetOpen && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/50 lg:hidden"
            onClick={() => setMoreSheetOpen(false)}
          />
          <div className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl bg-card shadow-xl lg:hidden animate-slide-up">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h3 className="text-sm font-semibold text-foreground">More</h3>
              <button
                onClick={() => setMoreSheetOpen(false)}
                className="rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-80 overflow-y-auto px-3 py-2 space-y-0.5">
              {moreNavItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreSheetOpen(false)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    isMobileNavActive(item.href)
                      ? 'bg-accent/30 text-primary'
                      : 'text-foreground hover:bg-accent'
                  }`}
                >
                  <item.icon className="h-5 w-5 flex-shrink-0" />
                  <span>{item.label}</span>
                </Link>
              ))}
            </div>
            <div className="h-6" />
          </div>
        </>
      )}
    </div>
    </UserProvider>
  )
}
