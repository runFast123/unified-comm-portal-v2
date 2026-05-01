'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Inbox,
  BarChart3,
  UserCircle,
  BookOpen,
  Settings,
  Plug,
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
  Tags,
  Building2,
  Smile,
  Webhook,
  Clock,
  type LucideIcon,
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
  /** Active company logo. When set, replaces the default "Unified Comms" wordmark. */
  brandLogoUrl?: string | null
  brandCompanyName?: string | null
  /**
   * Set of admin pages that exist on the deploy. Allows us to soft-hide
   * routes that haven't been added yet (e.g. /admin/time-reports). Defaults
   * to "show everything" so existing call-sites don't need changes.
   */
  enabledAdminPages?: {
    timeReports?: boolean
    csat?: boolean
  }
}

interface NavItem {
  label: string
  href: string
  icon: LucideIcon
  badge?: boolean
  /** Limit visibility to specific roles. */
  roles?: Array<'super_admin' | 'company_admin' | 'admin' | 'company_member'>
}

interface NavSection {
  /** Stable key used for localStorage persistence of expand/collapse state. */
  key: string
  label: string
  items: NavItem[]
  /** When true, renders a chevron and is collapsible. Defaults to true. */
  collapsible?: boolean
  /** Pre-render visibility filter (entire section hidden when false). */
  visible?: boolean
  /** Default open state when no localStorage value exists. */
  defaultOpen?: boolean
}

// ── Sidebar groups ────────────────────────────────────────────────────────
// Restructured from a flat list into themed sections so the nav scales as
// new admin pages are added each round. Sub-section open/close is persisted
// in localStorage under `sidebar-section:<key>`.

const INBOX_ITEMS: NavItem[] = [
  { label: 'Inbox', href: '/inbox', icon: Inbox, badge: true },
  { label: 'Bookmarks', href: '/inbox?view=bookmarks', icon: Bookmark },
]

const CUSTOMER_ITEMS: NavItem[] = [
  { label: 'Contacts', href: '/contacts', icon: UserCircle },
  { label: 'Knowledge Base', href: '/knowledge-base', icon: BookOpen },
]

const REPORT_ITEMS_BASE: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Reports', href: '/reports', icon: BarChart3 },
  { label: 'Observability', href: '/admin/observability', icon: Activity },
]

// Items rendered above the dynamic adminItems list — kept separate so we can
// reorder Companies (super_admin only) at the very top of the Admin section.
const ADMIN_ITEMS: NavItem[] = [
  { label: 'Companies', href: '/admin/companies', icon: Building2, roles: ['super_admin'] },
  { label: 'Account Settings', href: '/admin/accounts', icon: Settings },
  { label: 'Channels', href: '/admin/channels', icon: Plug },
  { label: 'Users', href: '/admin/users', icon: UserCog },
  { label: 'Routing', href: '/admin/routing', icon: GitBranch },
  { label: 'Templates', href: '/admin/templates', icon: FileText },
  { label: 'Statuses & Tags', href: '/admin/taxonomy', icon: Tags },
  { label: 'Company Signatures', href: '/admin/company-signatures', icon: FileText },
  { label: 'CSAT', href: '/admin/csat', icon: Smile },
  { label: 'Integrations', href: '/admin/integrations', icon: KeyRound },
  { label: 'AI Settings', href: '/admin/ai-settings', icon: Brain },
  { label: 'Notifications', href: '/admin/notifications', icon: Bell },
  { label: 'API Tokens', href: '/admin/api-tokens', icon: KeyRound },
  { label: 'Webhooks', href: '/admin/webhooks', icon: Webhook },
  { label: 'Health', href: '/admin/health', icon: Activity },
  { label: 'Logs', href: '/admin/logs', icon: FileText },
]

export function Sidebar({
  user,
  pendingCount,
  open,
  onClose,
  brandLogoUrl = null,
  brandCompanyName = null,
  enabledAdminPages,
}: SidebarProps) {
  const pathname = usePathname()
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('sidebar-collapsed') === 'true'
  })

  const isAdmin =
    user.role === 'admin' || user.role === 'company_admin' || user.role === 'super_admin'

  // Build the report section. Time Reports + CSAT only render when the page
  // exists (caller passes enabledAdminPages). Time Reports lives under Reports
  // because it's a metric, not a config screen.
  const reportItems: NavItem[] = [
    ...REPORT_ITEMS_BASE.slice(0, 2), // Dashboard, Reports
    ...(enabledAdminPages?.timeReports
      ? [{ label: 'Time Reports', href: '/admin/time-reports', icon: Clock }]
      : []),
    ...(enabledAdminPages?.csat
      ? [{ label: 'CSAT', href: '/admin/csat', icon: Smile }]
      : []),
    REPORT_ITEMS_BASE[2], // Observability
  ]

  // Strip Companies from the admin section if the user isn't a super_admin —
  // keeps the role-restricted UI from leaking even a placeholder row.
  const visibleAdminItems = ADMIN_ITEMS.filter((item) => {
    if (!item.roles || item.roles.length === 0) return true
    return item.roles.some((r) => user.role === r)
  })

  // Default Admin to collapsed on narrow viewports (md ≈ 768–1024px) and on
  // first load for non-admin viewers (the section won't render anyway, but
  // keeps the localStorage default sensible if their role is later promoted).
  const adminDefaultOpen = (() => {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem('sidebar-section:admin')
    if (stored !== null) return stored === 'true'
    // No stored pref — collapse on viewports < 1024px (Tailwind lg-).
    return window.innerWidth >= 1024
  })()

  const sections: NavSection[] = [
    { key: 'inbox', label: 'Inbox', items: INBOX_ITEMS, defaultOpen: true },
    { key: 'customers', label: 'Customers', items: CUSTOMER_ITEMS, defaultOpen: true },
    { key: 'reports', label: 'Reports', items: reportItems, defaultOpen: true },
    {
      key: 'admin',
      label: 'Admin',
      items: visibleAdminItems,
      visible: isAdmin,
      defaultOpen: adminDefaultOpen,
    },
  ]

  // Persisted per-section open/close state keyed by `sidebar-section:<key>`.
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') {
      return Object.fromEntries(sections.map((s) => [s.key, s.defaultOpen ?? true]))
    }
    return Object.fromEntries(
      sections.map((s) => {
        const stored = localStorage.getItem(`sidebar-section:${s.key}`)
        return [s.key, stored === null ? (s.defaultOpen ?? true) : stored === 'true']
      })
    )
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

  const toggleSection = (key: string) => {
    setSectionOpen((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      if (typeof window !== 'undefined') {
        localStorage.setItem(`sidebar-section:${key}`, String(next[key]))
      }
      return next
    })
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
    // Strip query so `/inbox?view=bookmarks` matches as "Bookmarks" only when
    // that exact query param is present.
    const [hrefPath, hrefQuery] = href.split('?')
    if (hrefPath === '/dashboard') return pathname === '/dashboard'
    if (hrefQuery) {
      if (pathname !== hrefPath) return false
      if (typeof window === 'undefined') return false
      const current = new URLSearchParams(window.location.search)
      const want = new URLSearchParams(hrefQuery)
      for (const [k, v] of want.entries()) {
        if (current.get(k) !== v) return false
      }
      return true
    }
    return pathname.startsWith(hrefPath)
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

  // Helper that renders a single nav link with its (optional) pending badge.
  const renderNavLink = (item: NavItem) => (
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
          <span className="relative">
            {collapsed ? (pendingCount > 9 ? '9+' : pendingCount) : (pendingCount > 99 ? '99+' : pendingCount)}
          </span>
        </span>
      )}
    </Link>
  )

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
        {/* Logo / Brand — replaced by company branding when configured. */}
        <div className={`flex h-16 items-center border-b border-sidebar-border ${collapsed ? 'justify-center px-2' : 'justify-between px-4'}`}>
          <Link href="/dashboard" className={`flex items-center ${collapsed ? 'justify-center' : 'gap-3'}`}>
            {brandLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={brandLogoUrl}
                alt={brandCompanyName ?? 'Company logo'}
                className="h-9 w-9 rounded-lg object-cover bg-white/5 shrink-0"
              />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm shrink-0">
                <MessageSquare className="h-5 w-5" />
              </div>
            )}
            {!collapsed && (
              <span className="text-lg font-semibold text-sidebar-foreground truncate">
                {brandCompanyName || 'Unified Comms'}
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
          {sections.map((section, sIdx) => {
            if (section.visible === false) return null
            const sectionItems = section.items
            if (sectionItems.length === 0) return null
            const isOpen = sectionOpen[section.key] ?? section.defaultOpen ?? true

            // Inbox section also hosts the Saved Views drawer; render it
            // immediately after the inbox nav links.
            const isInboxSection = section.key === 'inbox'

            return (
              <div key={section.key} className={sIdx === 0 ? '' : 'pt-1'}>
                {/* Section header — collapsible button (or rule when sidebar collapsed) */}
                <div className={collapsed ? 'pt-3 pb-1 px-2' : 'pt-3 pb-1 px-3'}>
                  {!collapsed ? (
                    <button
                      type="button"
                      onClick={() => toggleSection(section.key)}
                      className="flex w-full items-center justify-between rounded-md px-1 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-sidebar-foreground transition-colors"
                      aria-expanded={isOpen}
                      aria-controls={`sidebar-section-${section.key}`}
                    >
                      <span>{section.label}</span>
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : (
                    sIdx > 0 && <div className="border-t border-sidebar-border" />
                  )}
                </div>

                {/* Section body — items render when expanded, or always when
                    the sidebar is collapsed (icons need to remain reachable). */}
                {(isOpen || collapsed) && (
                  <div id={`sidebar-section-${section.key}`} className="space-y-1">
                    {sectionItems.map((item) => renderNavLink(item))}
                  </div>
                )}

                {/* Saved Views appears just under the Inbox section, before
                    the next section header. Hidden inside collapsed Inbox. */}
                {isInboxSection && (isOpen || collapsed) && (
                  <>
                    <div className={collapsed ? 'pt-3 pb-1 px-2' : 'pt-3 pb-1 px-3'}>
                      {!collapsed ? (
                        <button
                          type="button"
                          onClick={toggleSavedViewsOpen}
                          className="flex w-full items-center justify-between rounded-md px-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80 hover:text-sidebar-foreground transition-colors"
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
                  </>
                )}
              </div>
            )
          })}
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
          {/* Per-user signature settings — sits above Sign out so it's
              visible without requiring admin role. Hidden on the collapsed
              rail to keep the bottom area tidy. */}
          {!collapsed && (
            <Link
              href="/account/signature"
              onClick={onClose}
              className={`mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                pathname === '/account/signature'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              }`}
              title="Manage your email signature"
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span>My signature</span>
            </Link>
          )}
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
