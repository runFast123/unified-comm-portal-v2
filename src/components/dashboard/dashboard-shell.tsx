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
import { MentionsBell } from '@/components/dashboard/mentions-bell'
import { GlobalSearch } from '@/components/dashboard/global-search'
import { CompanySwitcher, type CompanyOption } from '@/components/dashboard/company-switcher'
import { CommandPalette } from '@/components/ui/command-palette'
import { KeyboardShortcuts } from '@/components/ui/keyboard-shortcuts'
import { UserProvider } from '@/context/user-context'
import type { User } from '@/types/database'

interface DashboardShellProps {
  user: Pick<User, 'email' | 'full_name' | 'role' | 'account_id'>
  pendingCount: number
  companyAccountIds?: string[]
  /**
   * The active tenant id, or `null` for super_admin "combined view".
   * Forwarded to UserProvider for consumer-page query gating, and to
   * CompanySwitcher so its trigger can render "All companies" when null.
   */
  activeCompanyId?: string | null
  /**
   * Whether the current user can see the "All companies" combined-view
   * option in the switcher dropdown. True for super_admin only.
   */
  canSeeAllCompanies?: boolean
  /** Companies the user can switch into. Hidden when ≤ 1. */
  accessibleCompanies?: CompanyOption[]
  /** The user's home company id (from `users.company_id`). */
  currentCompanyId?: string | null
  /** Active company branding — applied as CSS var + sidebar logo. */
  brandLogoUrl?: string | null
  brandAccentColor?: string | null
  brandCompanyName?: string | null
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

// Mirrors the sidebar's `roles?: string[]` gating so the mobile More sheet
// doesn't leak the existence of admin-only routes to plain company_member /
// viewer users. Server-side gates on each admin page still redirect non-
// admins, but hiding the entry point removes the cosmetic leak.
interface MoreNavItem {
  label: string
  href: string
  icon: typeof BookOpen
  /** Limit visibility to specific roles. When omitted, visible to everyone. */
  roles?: string[]
}

const ADMIN_ROLES = ['super_admin', 'company_admin']

const moreNavItems: MoreNavItem[] = [
  { label: 'Knowledge Base', href: '/knowledge-base', icon: BookOpen },
  { label: 'Admin Accounts', href: '/admin/accounts', icon: Settings, roles: ADMIN_ROLES },
  { label: 'Channels', href: '/admin/channels', icon: Plug, roles: ADMIN_ROLES },
  { label: 'Sheets Sync', href: '/admin/sheets', icon: Sheet, roles: ADMIN_ROLES },
  { label: 'AI Settings', href: '/admin/ai-settings', icon: Brain, roles: ADMIN_ROLES },
  { label: 'Notifications', href: '/admin/notifications', icon: BellIcon, roles: ADMIN_ROLES },
  { label: 'System Health', href: '/admin/health', icon: Activity, roles: ADMIN_ROLES },
  { label: 'Users', href: '/admin/users', icon: UserCog, roles: ADMIN_ROLES },
]

// Convert a URL slug ("time-reports") into a Title-Case label ("Time Reports").
// Special-cases common acronyms that would otherwise look wrong in
// breadcrumbs (e.g. "Api Tokens" -> "API Tokens").
function humanize(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    // Special-case acronyms
    .replace(/\bApi\b/g, 'API')
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bUi\b/g, 'UI')
    .replace(/\bKb\b/g, 'KB')
    .replace(/\bUrl\b/g, 'URL')
    .replace(/\bId\b/g, 'ID')
    .replace(/\bOauth\b/g, 'OAuth')
    .replace(/\bCsat\b/g, 'CSAT')
    .replace(/\bOoo\b/g, 'OOO')
}

/** UUID v4 detection — segments that look like a UUID are detail-page
 *  IDs and should never be humanized into a breadcrumb label (the user
 *  doesn't recognize "Ddc596a5 6aad 4b65 9866 43573377ef0a"). When we
 *  hit one, surface the parent collection's friendly label and tag the
 *  trailing crumb as "Detail" instead. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function getBreadcrumbs(pathname: string) {
  const segments = pathname.split('/').filter(Boolean)
  const crumbs: { label: string; href: string }[] = []

  if (segments[0] === 'admin' && segments.length > 1) {
    crumbs.push({ label: 'Admin', href: '/admin' })
    const fullPath = '/' + segments.join('/')
    const lastSegment = segments[segments.length - 1]
    // /admin/<collection>/<uuid> → "Admin / <Collection> / Detail"
    // Previously this rendered the raw UUID, humanized into letter-
    // case noise like "Ddc596a5 6aad 4b65 9866 43573377ef0a".
    if (segments.length >= 3 && UUID_RE.test(lastSegment)) {
      const parentPath = '/' + segments.slice(0, -1).join('/')
      const parentLabel =
        PAGE_TITLES[parentPath] ||
        (segments[1] ? humanize(segments[1]) : 'Detail')
      crumbs.push({ label: parentLabel, href: parentPath })
      crumbs.push({ label: 'Detail', href: pathname })
    } else {
      crumbs.push({
        label: PAGE_TITLES[fullPath] || humanize(lastSegment),
        href: fullPath,
      })
    }
  } else if (segments[0] === 'accounts' && segments.length > 1) {
    crumbs.push({ label: 'Accounts', href: '/accounts' })
    crumbs.push({ label: 'Account Detail', href: pathname })
  } else if (segments[0] === 'conversations' && segments.length > 1) {
    crumbs.push({ label: 'Inbox', href: '/inbox' })
    crumbs.push({ label: 'Conversation', href: pathname })
  } else {
    const fullPath = '/' + segments.join('/')
    const firstSegment = segments[0]
    crumbs.push({
      label:
        PAGE_TITLES[fullPath] ||
        (firstSegment ? humanize(firstSegment) : 'Dashboard'),
      href: fullPath,
    })
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

export function DashboardShell({
  user,
  pendingCount,
  companyAccountIds,
  activeCompanyId = null,
  canSeeAllCompanies = false,
  accessibleCompanies = [],
  currentCompanyId = null,
  brandLogoUrl = null,
  brandAccentColor = null,
  brandCompanyName = null,
  children,
}: DashboardShellProps) {
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

  // Apply company branding as a CSS variable (--brand-accent) on the root.
  // Existing teal accents remain default; explicit overrides apply.
  const rootStyle = brandAccentColor
    ? ({ ['--brand-accent' as never]: brandAccentColor } as React.CSSProperties)
    : undefined

  return (
    <UserProvider user={user} serverCompanyAccountIds={companyAccountIds} activeCompanyId={activeCompanyId}>
    <div className="flex h-screen overflow-hidden bg-background" style={rootStyle}>
      <Sidebar
        user={user}
        pendingCount={pendingCount}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        brandLogoUrl={brandLogoUrl}
        brandCompanyName={brandCompanyName}
        enabledAdminPages={{ timeReports: true }}
      />

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile header with hamburger */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-card/95 backdrop-blur-sm px-4 shadow-sm md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-all duration-200"
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
          <CompanySwitcher
            companies={accessibleCompanies}
            currentCompanyId={currentCompanyId}
            activeCompanyId={activeCompanyId}
            canSeeAllCompanies={canSeeAllCompanies}
          />
          <MentionsBell />
          <NotificationCenter />
          <GlobalSearch variant="mobile" />
          <button
            onClick={() => window.location.reload()}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-label="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </header>

        {/* Desktop breadcrumb bar */}
        <div className="hidden md:flex items-center justify-between border-b border-border bg-card/80 backdrop-blur-sm px-4 lg:px-8 py-2.5">
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
            <CompanySwitcher
              companies={accessibleCompanies}
              currentCompanyId={currentCompanyId}
              activeCompanyId={activeCompanyId}
              canSeeAllCompanies={canSeeAllCompanies}
            />
            <MentionsBell />
            <NotificationCenter />
            {/* Global Search */}
            <GlobalSearch />
          </div>
        </div>

        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 pb-24 md:pb-8 bg-background text-foreground" data-page-transition>
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
      <nav className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around border-t border-border bg-card px-2 py-1.5 shadow-[0_-2px_10px_rgba(0,0,0,0.05)] md:hidden">
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
            className="fixed inset-0 z-50 bg-black/50 md:hidden"
            onClick={() => setMoreSheetOpen(false)}
          />
          <div className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl bg-card shadow-xl md:hidden animate-slide-up">
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
              {moreNavItems
                .filter((item) => !item.roles || item.roles.includes(user.role))
                .map((item) => (
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
