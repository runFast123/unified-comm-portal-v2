'use client'

import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Keyboard } from 'lucide-react'
import { Button } from '@/components/ui/button'

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
    label: 'Conversation Actions',
    shortcuts: [
      { keys: ['Ctrl', 'Enter'], description: 'Send reply' },
      { keys: ['Ctrl', 'Shift', 'E'], description: 'Escalate conversation' },
      { keys: ['Ctrl', 'Shift', 'R'], description: 'Resolve conversation' },
    ],
  },
  {
    label: 'Templates',
    shortcuts: [
      { keys: ['/'], description: 'Open template shortcuts in reply box' },
      { keys: ['{{'], description: 'Variables: customer_name, account_name, email_subject' },
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
    <kbd className="inline-flex h-6 min-w-[24px] items-center justify-center rounded border border-border bg-zinc-50 px-1.5 text-xs font-semibold text-zinc-600 shadow-sm">
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
        className="relative z-10 w-full max-w-md rounded-xl bg-card shadow-2xl ring-1 ring-border"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold text-foreground">
              Keyboard Shortcuts
            </h2>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-6 py-4 space-y-5">
          {SHORTCUT_CATEGORIES.map((category) => (
            <div key={category.label}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                {category.label}
              </h3>
              <div className="space-y-1.5">
                {category.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.description}
                    className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-zinc-50"
                  >
                    <span className="text-sm text-zinc-700">
                      {shortcut.description}
                    </span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && (
                            <span className="text-[10px] text-zinc-400">
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
        <div className="border-t border-border px-6 py-3">
          <p className="text-xs text-zinc-500 text-center">
            Press <KeyBadge>?</KeyBadge> to toggle this dialog
          </p>
        </div>
      </div>
    </div>,
    document.body
  )
}
