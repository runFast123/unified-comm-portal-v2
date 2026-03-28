'use client'

import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Keyboard } from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────
interface Shortcut {
  keys: string[]
  description: string
}

interface ShortcutCategory {
  label: string
  shortcuts: Shortcut[]
}

// ─── Shortcut data ───────────────────────────────────────────────
const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  {
    label: 'Navigation',
    shortcuts: [
      { keys: ['g', 'i'], description: 'Go to Inbox' },
      { keys: ['g', 'd'], description: 'Go to Dashboard' },
      { keys: ['g', 'a'], description: 'Go to Accounts' },
      { keys: ['g', 'r'], description: 'Go to Reports' },
      { keys: ['g', 'k'], description: 'Go to Knowledge Base' },
    ],
  },
  {
    label: 'Actions',
    shortcuts: [
      { keys: ['a'], description: 'Archive conversation' },
      { keys: ['e'], description: 'Escalate conversation' },
      { keys: ['r'], description: 'Reply to conversation' },
      { keys: ['s'], description: 'Star / unstar' },
    ],
  },
  {
    label: 'Global',
    shortcuts: [
      { keys: ['\u2318', 'K'], description: 'Open command palette' },
      { keys: ['?'], description: 'Show keyboard shortcuts' },
      { keys: ['Esc'], description: 'Close modal / deselect' },
    ],
  },
]

// ─── Key badge ───────────────────────────────────────────────────
function KeyBadge({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-[24px] items-center justify-center rounded border border-gray-200 bg-gray-50 px-1.5 text-xs font-semibold text-gray-600 shadow-sm">
      {children}
    </kbd>
  )
}

// ─── Component ───────────────────────────────────────────────────
export interface KeyboardShortcutsProps {
  open: boolean
  onClose: () => void
}

export function KeyboardShortcuts({ open, onClose }: KeyboardShortcutsProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [open, handleKeyDown])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-md rounded-xl bg-white shadow-2xl ring-1 ring-gray-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div className="flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-gray-500" />
            <h2 className="text-lg font-semibold text-gray-900">
              Keyboard Shortcuts
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-6 py-4 space-y-5">
          {SHORTCUT_CATEGORIES.map((category) => (
            <div key={category.label}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                {category.label}
              </h3>
              <div className="space-y-1.5">
                {category.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.description}
                    className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-gray-50"
                  >
                    <span className="text-sm text-gray-700">
                      {shortcut.description}
                    </span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && (
                            <span className="text-[10px] text-gray-300">
                              then
                            </span>
                          )}
                          <KeyBadge>{key}</KeyBadge>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 px-6 py-3">
          <p className="text-xs text-gray-400 text-center">
            Press <KeyBadge>?</KeyBadge> to toggle this dialog
          </p>
        </div>
      </div>
    </div>,
    document.body
  )
}
