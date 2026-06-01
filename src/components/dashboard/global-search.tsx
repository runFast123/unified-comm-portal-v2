'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import {
  Search,
  Mail,
  BookOpen,
  ArrowRight,
  X,
  Loader2,
} from 'lucide-react'
import { createClient } from '@/lib/supabase-client'
import { useUser } from '@/context/user-context'
import { cn } from '@/lib/utils'

interface SearchResultItem {
  id: string
  type: 'message' | 'kb_article'
  title: string
  subtitle?: string
  href: string
}

const SECTION_LABELS: Record<string, string> = {
  message: 'Conversations',
  kb_article: 'Knowledge Base',
}

const SECTION_ICONS: Record<string, React.ReactNode> = {
  message: <Mail className="h-4 w-4" />,
  kb_article: <BookOpen className="h-4 w-4" />,
}

interface GlobalSearchProps {
  /** 'desktop' renders the wide button trigger; 'mobile' renders the icon-only trigger */
  variant?: 'desktop' | 'mobile'
}

export function GlobalSearch({ variant = 'desktop' }: GlobalSearchProps) {
  const router = useRouter()
  const { activeCompanyId, companyAccountIds } = useUser()
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [loading, setLoading] = useState(false)

  // Open modal
  const openSearch = useCallback(() => {
    setOpen(true)
    setQuery('')
    setResults([])
    setActiveIndex(0)
  }, [])

  const closeSearch = useCallback(() => {
    setOpen(false)
    setQuery('')
    setResults([])
  }, [])

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (open) {
          closeSearch()
        } else {
          openSearch()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, openSearch, closeSearch])

  // Search logic
  const performSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) {
      setResults([])
      return
    }

    setLoading(true)
    try {
      const supabase = createClient()
      const searchTerm = `%${trimmed}%`

      // Knowledge base: client-side ilike (small table). Tenant-scoped below.
      let kbQuery = supabase
        .from('kb_articles')
        .select('id, title, content, category')
        .or(`title.ilike.${searchTerm},content.ilike.${searchTerm}`)
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(5)

      // Tenant scope for KB: own accounts OR shared rows (account_id IS NULL).
      // Combined view (super_admin, activeCompanyId === null) runs unscoped.
      if (activeCompanyId) {
        kbQuery = kbQuery.or(companyAccountIds.map(id => `account_id.eq.${id}`).concat('account_id.is.null').join(','))
      }

      // Conversations: server-side Postgres full-text search — ranked, with a
      // highlighted snippet and message-body recall (far better than ilike).
      // Tenant scope is enforced inside the RPC; ?company_id narrows to the
      // active switcher company.
      const params = new URLSearchParams({ q: trimmed, limit: '6' })
      if (activeCompanyId) params.set('company_id', activeCompanyId)
      const convPromise = fetch(`/api/search?${params.toString()}`)
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .catch(() => ({ results: [] }))

      const [convRes, kbRes] = await Promise.all([convPromise, kbQuery])

      const items: SearchResultItem[] = []

      // Conversation (full-text) results
      ;((convRes as { results?: any[] }).results ?? []).forEach((c: any) => {
        const cleanName = (c.participant_name || c.participant_email || 'Unknown')
          .replace(/<[^>]+>/g, '')
          .replace(/^["']+|["']+$/g, '')
          .trim()
        // headline carries <mark> tags from ts_headline — strip for plain render.
        const snippet = (c.headline || '').replace(/<\/?mark>/g, '').trim()
        items.push({
          id: `conv-${c.id}`,
          type: 'message',
          title: snippet || cleanName || '(conversation)',
          subtitle: `${cleanName}${c.channel ? ` via ${c.channel}` : ''}`,
          href: `/conversations/${c.id}`,
        })
      })

      // KB article results
      ;(kbRes.data ?? []).forEach((kb: any) => {
        items.push({
          id: `kb-${kb.id}`,
          type: 'kb_article',
          title: kb.title,
          subtitle: kb.category || undefined,
          href: '/knowledge-base',
        })
      })

      setResults(items)
      setActiveIndex(0)
    } catch (err) {
      console.error('Global search error:', err)
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [activeCompanyId, companyAccountIds])

  // 300ms debounce
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => performSearch(query), 300)
    return () => clearTimeout(timer)
  }, [query, performSearch, open])

  // Navigate to result
  const navigateTo = useCallback(
    (result: SearchResultItem) => {
      closeSearch()
      router.push(result.href)
    },
    [closeSearch, router]
  )

  // Keyboard navigation inside modal
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeSearch()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % Math.max(results.length, 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + results.length) % Math.max(results.length, 1))
      } else if (e.key === 'Enter' && results[activeIndex]) {
        navigateTo(results[activeIndex])
      }
    },
    [closeSearch, results, activeIndex, navigateTo]
  )

  // Group results by type
  const grouped = {
    message: results.filter((r) => r.type === 'message'),
    kb_article: results.filter((r) => r.type === 'kb_article'),
  }

  let flatIndex = 0

  const modal = open && typeof document !== 'undefined'
    ? createPortal(
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm"
            onClick={closeSearch}
            aria-hidden="true"
          />
          {/* Modal */}
          <div
            role="dialog"
            aria-modal="true"
            className="relative z-10 w-full max-w-lg rounded-xl bg-white shadow-2xl ring-1 ring-gray-200 overflow-hidden dark:bg-gray-900 dark:ring-gray-700"
            onKeyDown={handleKeyDown}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
              <Search className="h-5 w-5 text-gray-400 flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                placeholder="Search messages, knowledge base..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="flex-1 bg-transparent text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none"
              />
              {loading && (
                <Loader2 className="h-4 w-4 animate-spin text-gray-400 flex-shrink-0" />
              )}
              <button
                onClick={closeSearch}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Results */}
            <div className="max-h-80 overflow-y-auto py-2">
              {query.trim() === '' && (
                <p className="px-4 py-6 text-center text-sm text-gray-400">
                  Start typing to search messages and knowledge base articles...
                </p>
              )}

              {query.trim() !== '' && results.length === 0 && !loading && (
                <p className="px-4 py-6 text-center text-sm text-gray-400">
                  No results found for &ldquo;{query.trim()}&rdquo;
                </p>
              )}

              {(['message', 'kb_article'] as const).map((type) => {
                const items = grouped[type]
                if (items.length === 0) return null
                return (
                  <div key={type}>
                    <p className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                      {SECTION_LABELS[type]}
                    </p>
                    {items.map((result) => {
                      const idx = flatIndex++
                      return (
                        <button
                          key={result.id}
                          onClick={() => navigateTo(result)}
                          onMouseEnter={() => setActiveIndex(idx)}
                          className={cn(
                            'flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors',
                            idx === activeIndex
                              ? 'bg-teal-50 text-teal-900 dark:bg-teal-900/30 dark:text-teal-100'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                          )}
                        >
                          <span className={cn(
                            'flex-shrink-0',
                            idx === activeIndex ? 'text-teal-600' : 'text-gray-400'
                          )}>
                            {SECTION_ICONS[result.type]}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="truncate font-medium">{result.title}</p>
                            {result.subtitle && (
                              <p className="truncate text-xs text-gray-400 mt-0.5">{result.subtitle}</p>
                            )}
                          </div>
                          {idx === activeIndex && (
                            <ArrowRight className="h-3.5 w-3.5 text-teal-500 flex-shrink-0" />
                          )}
                        </button>
                      )
                    })}
                  </div>
                )
              })}

              {loading && results.length === 0 && query.trim() !== '' && (
                <div className="flex items-center justify-center py-4">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-gray-100 dark:border-gray-800 px-4 py-2 text-[11px] text-gray-400">
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-1 py-0.5 text-[10px]">&#8984;K</kbd>
                {' '}to toggle
              </span>
              <span>
                <kbd className="rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-1 py-0.5 text-[10px]">&#8593;&#8595;</kbd>
                {' '}navigate{' '}
                <kbd className="rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-1 py-0.5 text-[10px]">&#9166;</kbd>
                {' '}select
              </span>
            </div>
          </div>
        </div>,
        document.body
      )
    : null

  return (
    <>
      {variant === 'desktop' ? (
        <button
          onClick={openSearch}
          className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-1.5 text-sm text-muted-foreground hover:border-border hover:text-muted-foreground transition-colors"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden xl:inline">Search...</span>
          <kbd className="hidden xl:inline-flex items-center rounded border border-border bg-card px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
            &#8984;K
          </kbd>
        </button>
      ) : (
        <button
          onClick={openSearch}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </button>
      )}

      {modal}
    </>
  )
}
