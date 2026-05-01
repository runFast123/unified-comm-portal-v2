'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Check, ChevronDown } from 'lucide-react'

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
}

/**
 * Company picker dropdown.
 *
 * Hidden when the user has access to ≤1 company. Otherwise shows a button
 * with the current company's logo + name; click opens a list of all
 * accessible companies. On switch, persists the selection in a cookie +
 * localStorage so server components can read it on next render, and
 * triggers `router.refresh()`.
 */
export function CompanySwitcher({ companies, currentCompanyId }: CompanySwitcherProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // On mount, hydrate from cookie/localStorage, falling back to currentCompanyId.
  useEffect(() => {
    const stored = getSelectedCompanyId()
    if (stored && companies.some((c) => c.id === stored)) {
      setSelectedId(stored)
    } else if (currentCompanyId) {
      setSelectedId(currentCompanyId)
    } else if (companies.length > 0) {
      setSelectedId(companies[0].id)
    }
  }, [companies, currentCompanyId])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id)
      setSelectedCompanyId(id)
      setOpen(false)
      router.refresh()
    },
    [router],
  )

  // Don't render at all when there's nothing to switch.
  if (companies.length <= 1) return null

  const current = companies.find((c) => c.id === selectedId) ?? companies[0]

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-700 shadow-sm hover:bg-gray-50 transition-colors max-w-[220px]"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Switch company (currently: ${current?.name ?? 'unknown'})`}
      >
        {current?.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={current.logo_url}
            alt=""
            className="h-5 w-5 rounded object-cover bg-gray-50"
          />
        ) : (
          <Building2 className="h-4 w-4 text-gray-500" />
        )}
        <span className="truncate font-medium">{current?.name ?? 'Select company'}</span>
        <ChevronDown className="h-3.5 w-3.5 text-gray-400 shrink-0" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg max-h-[60vh] overflow-y-auto"
        >
          <div className="py-1">
            {companies.map((c) => {
              const isSelected = c.id === current?.id
              return (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => handleSelect(c.id)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                    isSelected ? 'bg-teal-50 text-teal-800' : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {c.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.logo_url}
                      alt=""
                      className="h-5 w-5 rounded object-cover bg-gray-50 shrink-0"
                    />
                  ) : (
                    <Building2 className="h-4 w-4 text-gray-500 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{c.name}</p>
                    {c.slug && (
                      <p className="font-mono text-[11px] text-gray-500 truncate">{c.slug}</p>
                    )}
                  </div>
                  {c.accent_color && (
                    <span
                      className="inline-block h-3 w-3 rounded-full ring-1 ring-gray-200 shrink-0"
                      style={{ backgroundColor: c.accent_color }}
                      aria-hidden="true"
                    />
                  )}
                  {isSelected && <Check className="h-4 w-4 text-teal-700 shrink-0" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
