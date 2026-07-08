'use client'

import { useEffect, useCallback, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  /** Accessible name when no visible `title` is rendered (aria-label). */
  ariaLabel?: string
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({ open, onClose, title, ariaLabel, children, footer, className }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  // The element focused before the dialog opened, so we can restore focus on close.
  const restoreRef = useRef<HTMLElement | null>(null)
  const titleId = useId()

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      // Focus trap: keep Tab / Shift+Tab inside the dialog.
      if (e.key === 'Tab') {
        const root = dialogRef.current
        if (!root) return
        const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null || el === document.activeElement
        )
        if (focusable.length === 0) {
          e.preventDefault()
          root.focus()
          return
        }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault()
            last.focus()
          }
        } else if (active === last || !root.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    },
    [onClose]
  )

  useEffect(() => {
    if (!open) return
    // Remember what had focus, then move focus into the dialog.
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'

    // Focus the first focusable element (or the dialog itself) after paint.
    const root = dialogRef.current
    const target =
      root?.querySelector<HTMLElement>(FOCUSABLE) ?? root ?? null
    // rAF so the portal content is mounted before we focus.
    const raf = requestAnimationFrame(() => target?.focus())

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
      // Restore focus to the trigger on close (guard against detached nodes).
      const restore = restoreRef.current
      if (restore && document.contains(restore)) restore.focus()
    }
  }, [open, handleKeyDown])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? ariaLabel : undefined}
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full sm:max-w-lg max-w-full sm:mx-auto mx-0 sm:rounded-xl rounded-none sm:my-8 my-0 sm:h-auto h-full bg-card shadow-xl focus:outline-none',
          className
        )}
      >
        {/* Header */}
        {title && (
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <h2 id={titleId} className="text-lg font-semibold text-foreground">{title}</h2>
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
        )}
        {/* Body */}
        <div className="px-6 py-4">{children}</div>
        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
