'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import {
  Search,
  LayoutDashboard,
  Inbox,
  Users,
  BarChart3,
  BookOpen,
  Settings,
  Mail,
  MessageSquare,
  ArrowRight,
  Command,
} from 'lucide-react'
import { createClient } from '@/lib/supabase-client'
import { cn } from '@/lib/utils'

// ─── Types ───────────────────────────────────────────────────────
interface SearchResult {
  id: string
  type: 'page' | 'message' | 'account'
  title: string
  subtitle?: string
  href: string
  icon: React.ReactNode
}

// ─── Static page results ─────────────────────────────────────────
const PAGE_RESULTS: SearchResult[] = [
  { id: 'p-dashboard', type: 'page', title: 'Dashboard', href: '/dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
  { id: 'p-inbox', type: 'page', title: 'Unified Inbox', href: '/inbox', icon: <Inbox className="h-4 w-4" /> },
  { id: 'p-accounts', type: 'page', title: 'Accounts', href: '/accounts', icon: <Users className="h-4 w-4" /> },
  { id: 'p-reports', type: 'page', title: 'Reports & Analytics', href: '/reports', icon: <BarChart3 className="h-4 w-4" /> },
  { id: 'p-kb', type: 'page', title: 'Knowledge Base', href: '/knowledge-base', icon: <BookOpen className="h-4 w-4" /> },
  { id: 'p-admin-accounts', type: 'page', title: 'Account Management', subtitle: 'Admin', href: '/admin/accounts', icon: <Settings className="h-4 w-4" /> },
  { id: 'p-admin-channels', type: 'page', title: 'Channel Configuration', subtitle: 'Admin', href: '/admin/channels', icon: <Settings className="h-4 w-4" /> },
  { id: 'p-admin-ai', type: 'page', title: 'AI Settings', subtitle: 'Admin', href: '/admin/ai-settings', icon: <Settings className="h-4 w-4" /> },
  { id: 'p-admin-health', type: 'page', title: 'System Health', subtitle: 'Admin', href: '/admin/health', icon: <Settings className="h-4 w-4" /> },
]

// ─── Component ───────────────────────────────────────────────────
export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [loading, setLoading] = useState(false)

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // Search logic
  const search = useCallback(
    async (q: string) => {
      const trimmed = q.trim().toLowerCase()
      if (!trimmed) {
        setResults([])
        return
      }

      // Pages
      const pageMatches = PAGE_RESULTS.filter(
        (p) =>
          p.title.toLowerCase().includes(trimmed) ||
          (p.subtitle && p.subtitle.toLowerCase().includes(trimmed))
      )

      // Supabase searches
      setLoading(true)
      try {
        const supabase = createClient()

        const [messagesRes, accountsRes] = await Promise.all([
          supabase
            .from('messages')
            .select('id, conversation_id, email_subject, sender_name, channel')
            .or(`email_subject.ilike.%${trimmed}%,sender_name.ilike.%${trimmed}%,message_text.ilike.%${trimmed}%`)
            .eq('direction', 'inbound')
            .order('received_at', { ascending: false })
            .limit(5),
          supabase
            .from('accounts')
            .select('id, name, channel_type')
            .ilike('name', `%${trimmed}%`)
            .limit(5),
        ])

        const messageResults: SearchResult[] = (messagesRes.data ?? []).map((m: any) => {
          const cleanSender = (m.sender_name || 'Unknown').replace(/<[^>]+>/g, '').replace(/^["']+|["']+$/g, '').trim()
          return {
            id: `m-${m.id}`,
            type: 'message' as const,
            title: m.email_subject || '(No subject)',
            subtitle: cleanSender,
            href: `/conversations/${m.conversation_id || m.id}`,
            icon: <Mail className="h-4 w-4" />,
          }
        })

        const accountResults: SearchResult[] = (accountsRes.data ?? []).map((a) => ({
          id: `a-${a.id}`,
          type: 'account' as const,
          title: a.name,
          subtitle: a.channel_type,
          href: `/accounts/${a.id}`,
          icon: <MessageSquare className="h-4 w-4" />,
        }))

        setResults([...pageMatches, ...messageResults, ...accountResults])
        setActiveIndex(0)
      } catch {
        // Silently fail; page results still show
        setResults(pageMatches)
      } finally {
        setLoading(false)
      }
    },
    []
  )

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => search(query), 200)
    return () => clearTimeout(timer)
  }, [query, search])

  // Navigate to result
  const navigate = useCallback(
    (result: SearchResult) => {
      onClose()
      router.push(result.href)
    },
    [onClose, router]
  )

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % Math.max(results.length, 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + results.length) % Math.max(results.length, 1))
      } else if (e.key === 'Enter' && results[activeIndex]) {
        navigate(results[activeIndex])
      }
    },
    [onClose, results, activeIndex, navigate]
  )

  if (!open) return null

  // Group results by type
  const grouped = {
    page: results.filter((r) => r.type === 'page'),
    message: results.filter((r) => r.type === 'message'),
    account: results.filter((r) => r.type === 'account'),
  }

  const groupLabels: Record<string, string> = {
    page: 'Pages',
    message: 'Messages',
    account: 'Accounts',
  }

  // Flat index helper
  let flatIndex = 0

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Palette */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-lg rounded-xl bg-white shadow-2xl ring-1 ring-gray-200 overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
          <Search className="h-5 w-5 text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search messages, accounts, pages..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm text-gray-900 placeholder:text-gray-400 outline-none"
          />
          <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto py-2">
          {query.trim() === '' && (
            <p className="px-4 py-6 text-center text-sm text-gray-400">
              Start typing to search...
            </p>
          )}

          {query.trim() !== '' && results.length === 0 && !loading && (
            <p className="px-4 py-6 text-center text-sm text-gray-400">
              No results found.
            </p>
          )}

          {(['page', 'message', 'account'] as const).map((type) => {
            const items = grouped[type]
            if (items.length === 0) return null
            return (
              <div key={type}>
                <p className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                  {groupLabels[type]}
                </p>
                {items.map((result) => {
                  const idx = flatIndex++
                  return (
                    <button
                      key={result.id}
                      onClick={() => navigate(result)}
                      onMouseEnter={() => setActiveIndex(idx)}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors',
                        idx === activeIndex
                          ? 'bg-teal-50 text-teal-900'
                          : 'text-gray-700 hover:bg-gray-50'
                      )}
                    >
                      <span className={cn(
                        'flex-shrink-0',
                        idx === activeIndex ? 'text-teal-600' : 'text-gray-400'
                      )}>
                        {result.icon}
                      </span>
                      <span className="flex-1 truncate font-medium">
                        {result.title}
                      </span>
                      {result.subtitle && (
                        <span className="text-xs text-gray-400">
                          {result.subtitle}
                        </span>
                      )}
                      {idx === activeIndex && (
                        <ArrowRight className="h-3.5 w-3.5 text-teal-500 flex-shrink-0" />
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}

          {loading && (
            <div className="flex items-center justify-center py-4">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          <span className="flex items-center gap-1">
            <Command className="h-3 w-3" /> K to toggle
          </span>
          <span>
            <kbd className="rounded border border-gray-200 bg-gray-50 px-1 py-0.5 text-[10px]">&#8593;&#8595;</kbd>
            {' '}navigate{' '}
            <kbd className="rounded border border-gray-200 bg-gray-50 px-1 py-0.5 text-[10px]">&#9166;</kbd>
            {' '}select
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
}
