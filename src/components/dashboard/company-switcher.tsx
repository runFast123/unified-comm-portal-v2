'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { Building2, Check, ChevronDown, Globe } from 'lucide-react'

export interface CompanyOption {
  id: string
  name: string
  slug: string | null
  logo_url: string | null
  accent_color: string | null
}

const COMPANY_COOKIE = 'selected_company_id'
const COMPANY_STORAGE_KEY = 'selected_company_id'

/** Read the currently-selected company id from cookie or localStorage. */
export function getSelectedCompanyId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const cookies = document.cookie.split(';').map((c) => c.trim())
    const match = cookies.find((c) => c.startsWith(`${COMPANY_COOKIE}=`))
    if (match) return decodeURIComponent(match.slice(COMPANY_COOKIE.length + 1))
  } catch { /* fall through */ }
  try {
    return localStorage.getItem(COMPANY_STORAGE_KEY)
  } catch { return null }
}

function setSelectedCompanyId(id: string | null) {
  if (typeof window === 'undefined') return
  try {
    if (id) {
      // 30 day expiry, root path. SameSite=Lax + Secure when HTTPS.
      const secure = window.location.protocol === 'https:' ? '; Secure' : ''
      const maxAge = 60 * 60 * 24 * 30
      document.cookie = `${COMPANY_COOKIE}=${encodeURIComponent(id)}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`
      localStorage.setItem(COMPANY_STORAGE_KEY, id)
    } else {
      document.cookie = `${COMPANY_COOKIE}=; Max-Age=0; Path=/`
      localStorage.removeItem(COMPANY_STORAGE_KEY)
    }
  } catch { /* ignore */ }
}

interface CompanySwitcherProps {
  companies: CompanyOption[]
  /** Current user's company_id (from auth profile). Used as default selection. */
  currentCompanyId: string | null
  /**
   * Server-resolved active tenant id. `null` indicates super_admin
   * combined view ("All companies"). When provided, the trigger label
   * follows this prop instead of the locally hydrated selection so the
   * button stays in sync with what's actually being rendered.
   */
  activeCompanyId?: string | null
  /**
   * When true (super_admin), the dropdown shows an "All companies" item
   * at the top that clears the cookie and switches to combined view.
   * Hidden for everyone else — non-admins can't go cross-tenant.
   */
  canSeeAllCompanies?: boolean
}

/**
 * Company picker dropdown.
 *
 * Hidden when the user has access to ≤1 company. Otherwise shows a button
 * with the current company's logo + name; click opens a list of all
 * accessible companies. On switch, persists the selection in a cookie +
 * localStorage so server components can read it on next render, and
 * triggers `router.refresh()`.
 *
 * For super_admin: adds an "All companies" item at the top that clears
 * the cookie and triggers combined-view (cross-tenant) data on refresh.
 */
export function CompanySwitcher({ companies, currentCompanyId, activeCompanyId = null, canSeeAllCompanies = false }: CompanySwitcherProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Portal target only available after mount (SSR-safe).
  useEffect(() => { setMounted(true) }, [])

  // Recompute dropdown position whenever it opens, the window resizes, or
  // the page scrolls. Right-edge alignment under the button. position: fixed
  // lets the panel escape ALL parent stacking/overflow contexts so the
  // header's filter row can't render on top of it.
  useEffect(() => {
    if (!open) return
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect()
      if (!r) return
      setCoords({
        top: r.bottom + 4,
        right: window.innerWidth - r.right,
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // On mount, hydrate from cookie/localStorage, falling back to currentCompanyId.
  // When the parent passes `activeCompanyId` (server-resolved), let that
  // win — it's already cookie-checked and accessibility-checked upstream.
  useEffect(() => {
    if (activeCompanyId !== undefined && activeCompanyId !== null) {
      setSelectedId(activeCompanyId)
      return
    }
    // activeCompanyId === null is a valid signal (super_admin combined view).
    // Don't auto-fill from localStorage in that case — the button will
    // render the "All companies" label via the activeCompanyId === null
    // branch below.
    if (activeCompanyId === null && canSeeAllCompanies) {
      setSelectedId(null)
      return
    }
    const stored = getSelectedCompanyId()
    if (stored && companies.some((c) => c.id === stored)) {
      setSelectedId(stored)
    } else if (currentCompanyId) {
      setSelectedId(currentCompanyId)
    } else if (companies.length > 0) {
      setSelectedId(companies[0].id)
    }
  }, [companies, currentCompanyId, activeCompanyId, canSeeAllCompanies])

  // Close on outside click. The panel lives in a portal so we also check
  // its dedicated ref — clicking inside the portal must NOT close.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (containerRef.current?.contains(target)) return
      // Also allow clicks inside the portal panel itself.
      const panel = document.getElementById('company-switcher-panel')
      if (panel?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const handleSelect = useCallback(
    (id: string | null) => {
      setSelectedId(id)
      setSelectedCompanyId(id)
      setOpen(false)
      router.refresh()
    },
    [router],
  )

  // Don't render at all when there's nothing to switch.
  if (companies.length <= 1) return null

  // Combined-view mode renders a distinct "All companies" label on the
  // trigger button. We rely on `activeCompanyId === null` (server truth)
  // rather than `selectedId === null` (client state) so the button can't
  // get out of sync with what's actually being rendered.
  const isCombined = canSeeAllCompanies && activeCompanyId === null
  const current = isCombined ? null : companies.find((c) => c.id === selectedId) ?? companies[0]

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-zinc-700 shadow-sm hover:bg-accent transition-colors max-w-[220px]"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Switch company (currently: ${isCombined ? 'All companies' : current?.name ?? 'unknown'})`}
      >
        {isCombined ? (
          <Globe className="h-4 w-4 text-[var(--brand-accent)]" />
        ) : current?.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={current.logo_url}
            alt=""
            className="h-5 w-5 rounded object-cover bg-muted"
          />
        ) : (
          <Building2 className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="truncate font-medium">
          {isCombined ? 'All companies' : current?.name ?? 'Select company'}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
      </button>

      {open && mounted && coords && createPortal(
        <div
          id="company-switcher-panel"
          role="listbox"
          style={{ position: 'fixed', top: coords.top, right: coords.right, zIndex: 9999 }}
          className="w-72 rounded-lg border border-border bg-card shadow-lg max-h-[60vh] overflow-y-auto"
        >
          <div className="py-1">
            {canSeeAllCompanies && (
              <>
                <button
                  type="button"
                  role="option"
                  aria-selected={isCombined}
                  onClick={() => handleSelect(null)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                    isCombined ? 'bg-[var(--brand-accent)]/10 text-[var(--brand-accent)]' : 'text-zinc-700 hover:bg-accent'
                  }`}
                >
                  <Globe className="h-4 w-4 text-[var(--brand-accent)] shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">All companies</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      Combined view across every tenant
                    </p>
                  </div>
                  {isCombined && <Check className="h-4 w-4 text-[var(--brand-accent)] shrink-0" />}
                </button>
                <div className="my-1 border-t border-border" />
              </>
            )}
            {companies.map((c) => {
              const isSelected = !isCombined && c.id === current?.id
              return (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => handleSelect(c.id)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                    isSelected ? 'bg-[var(--brand-accent)]/10 text-[var(--brand-accent)]' : 'text-zinc-700 hover:bg-accent'
                  }`}
                >
                  {c.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.logo_url}
                      alt=""
                      className="h-5 w-5 rounded object-cover bg-muted shrink-0"
                    />
                  ) : (
                    <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{c.name}</p>
                    {c.slug && (
                      <p className="font-mono text-[11px] text-muted-foreground truncate">{c.slug}</p>
                    )}
                  </div>
                  {c.accent_color && (
                    <span
                      className="inline-block h-3 w-3 rounded-full ring-1 ring-border shrink-0"
                      style={{ backgroundColor: c.accent_color }}
                      aria-hidden="true"
                    />
                  )}
                  {isSelected && <Check className="h-4 w-4 text-[var(--brand-accent)] shrink-0" />}
                </button>
              )
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
