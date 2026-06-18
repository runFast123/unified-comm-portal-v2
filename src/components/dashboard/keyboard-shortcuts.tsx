'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { X, Keyboard } from 'lucide-react'

/**
 * Global keyboard-shortcut provider.
 *
 * - Installs a single window-level `keydown` listener.
 * - Renders a cheatsheet modal when `?` is pressed.
 * - Supports g-then-X chord bindings for navigation with a 1s window.
 *
 * NEVER fires while focus is inside an editable control (input, textarea,
 * contenteditable) or a modifier key (meta/ctrl/alt) is held — those are
 * reserved for browser/OS shortcuts and in-page typing. Shift is allowed
 * because `?` requires it.
 */

/** Rows in the cheatsheet. */
type ShortcutRow = { label: string; keys: (string | 'then')[] }
type ShortcutGroup = { title: string; rows: ShortcutRow[] }

const GROUPS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    rows: [
      { label: 'Go to Dashboard', keys: ['g', 'then', 'd'] },
      { label: 'Go to Inbox', keys: ['g', 'then', 'i'] },
      { label: 'Go to Reports', keys: ['g', 'then', 'r'] },
      { label: 'Go to Contacts', keys: ['g', 'then', 'c'] },
      { label: 'Go to Knowledge Base', keys: ['g', 'then', 'k'] },
    ],
  },
  {
    title: 'Inbox',
    rows: [
      { label: 'Focus search (on /inbox)', keys: ['/'] },
      // Row-triage shortcuts (handled in inbox-list.tsx, list & split views).
      { label: 'Navigate rows', keys: ['j', 'k'] },
      { label: 'Navigate rows (arrows)', keys: ['↑', '↓'] },
      { label: 'Open focused conversation', keys: ['Enter'] },
      { label: 'Open focused conversation', keys: ['o'] },
      { label: 'Select / deselect focused row', keys: ['x'] },
      { label: 'Archive focused row', keys: ['e'] },
      { label: 'Reply (opens conversation)', keys: ['r'] },
    ],
  },
  {
    title: 'Help',
    rows: [
      { label: 'Open this cheatsheet', keys: ['?'] },
      { label: 'Close modal', keys: ['Esc'] },
    ],
  },
]

/** Tailwind-JIT-friendly static <kbd> matching Linear's style. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] font-medium text-gray-700 shadow-sm">
      {children}
    </kbd>
  )
}

/**
 * Returns true when we should suppress a global shortcut because the user is
 * typing or interacting with a control that owns the keystroke.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  // Button/role=button on the cheatsheet close should still work via Enter
  // but we don't want a bare "g" on a focused button to navigate.
  if (tag === 'BUTTON') return true
  return false
}

export function KeyboardShortcutProvider() {
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const chordRef = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null)

  const clearChord = useCallback(() => {
    if (chordRef.current) {
      clearTimeout(chordRef.current.timer)
      chordRef.current = null
    }
  }, [])

  const startChord = useCallback((key: string) => {
    clearChord()
    const timer = setTimeout(() => {
      chordRef.current = null
    }, 1000)
    chordRef.current = { key, timer }
  }, [clearChord])

  // Allow any component (e.g. the sidebar hint) to open the modal.
  useEffect(() => {
    const openHandler = () => setOpen(true)
    window.addEventListener('shortcuts:open', openHandler)
    return () => window.removeEventListener('shortcuts:open', openHandler)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Modifier-bearing keys are always reserved for the browser/OS
      // (Cmd+K, Ctrl+F, Alt+Tab, etc). Shift is allowed because `?` = Shift+/.
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Escape closes the modal regardless of focus target — it's always
      // safe even while focused on the close button.
      if (e.key === 'Escape') {
        if (open) {
          e.preventDefault()
          setOpen(false)
          clearChord()
        }
        return
      }

      // If the user is typing somewhere, don't fire any other shortcut.
      if (isTypingTarget(e.target)) return

      // `?` opens the cheatsheet (Shift+/ on US layouts).
      if (e.key === '?') {
        e.preventDefault()
        setOpen((v) => !v)
        clearChord()
        return
      }

      // While the modal is open, don't trigger any other bindings.
      if (open) return

      // `/` focuses the inbox search — only on /inbox.
      if (e.key === '/' && !e.shiftKey) {
        if (pathname === '/inbox') {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('inbox:focus-search'))
        }
        return
      }

      // Chord: `g` then X.
      if (chordRef.current?.key === 'g') {
        const next = e.key.toLowerCase()
        const routes: Record<string, string> = {
          i: '/inbox',
          d: '/dashboard',
          r: '/reports',
          c: '/contacts',
          k: '/knowledge-base',
        }
        const target = routes[next]
        if (target) {
          e.preventDefault()
          router.push(target)
        }
        clearChord()
        return
      }

      if (e.key === 'g' && !e.shiftKey) {
        // Start a chord; don't preventDefault — the user might still type
        // something else that we ignore.
        startChord('g')
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [open, pathname, router, clearChord, startChord])

  // Clean up any pending chord timer on unmount.
  useEffect(() => () => clearChord(), [clearChord])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-fade-in"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white shadow-xl ring-1 ring-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50 text-teal-700 ring-1 ring-teal-200">
              <Keyboard className="h-4 w-4" strokeWidth={2} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Help
              </p>
              <h2 className="text-[15px] font-semibold leading-tight text-gray-900">
                Keyboard Shortcuts
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto px-6 py-4">
          {GROUPS.map((group) => (
            <div key={group.title} className="mb-5 last:mb-0">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                {group.title}
              </p>
              <div>
                {group.rows.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between gap-4 border-b border-gray-100 py-2 last:border-0"
                  >
                    <span className="text-sm text-gray-700">{row.label}</span>
                    <div className="flex flex-shrink-0 items-center gap-1">
                      {row.keys.map((k, i) =>
                        k === 'then' ? (
                          <span key={i} className="text-xs text-gray-400">
                            then
                          </span>
                        ) : (
                          <Kbd key={i}>{k}</Kbd>
                        )
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 bg-gradient-to-b from-gray-50/50 to-transparent px-6 py-3">
          <p className="text-xs text-gray-500">
            Tip: press <Kbd>?</Kbd> anywhere to reopen this.
          </p>
        </div>
      </div>
    </div>
  )
}
