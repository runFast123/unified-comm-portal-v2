'use client'

import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'

export interface ConfirmOptions {
  /** Dialog heading. Defaults to "Please confirm". */
  title?: string
  /** Body content — a string (newlines preserved) or a rich node. */
  message: React.ReactNode
  /** Confirm button label. Defaults to "Confirm". */
  confirmText?: string
  /** Cancel button label. Defaults to "Cancel". */
  cancelText?: string
  /** Style the confirm button as destructive (red). */
  danger?: boolean
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/**
 * App-wide async confirmation dialog. Replaces native `window.confirm`, which
 * is off-brand AND can be permanently suppressed by the browser's "prevent
 * this page from creating additional dialogs" checkbox — after which a
 * suppressed confirm returns false and the action silently never happens.
 *
 * Usage:
 *   const confirm = useConfirm()
 *   if (!(await confirm({ message: 'Delete this?', danger: true }))) return
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const resolverRef = useRef<((v: boolean) => void) | null>(null)

  const settle = useCallback((value: boolean) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setOpts(null)
    resolve?.(value)
  }, [])

  const confirm = useCallback<ConfirmFn>((next) => {
    // If a prior confirm is somehow still open, resolve it false before
    // replacing it so its awaiter never hangs.
    resolverRef.current?.(false)
    setOpts(next)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
    })
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={!!opts}
        onClose={() => settle(false)}
        title={opts?.title ?? 'Please confirm'}
        footer={
          opts ? (
            <>
              <Button variant="ghost" onClick={() => settle(false)}>
                {opts.cancelText ?? 'Cancel'}
              </Button>
              <Button variant={opts.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
                {opts.confirmText ?? 'Confirm'}
              </Button>
            </>
          ) : null
        }
      >
        <div className="whitespace-pre-line text-sm leading-relaxed text-gray-700">{opts?.message}</div>
      </Modal>
    </ConfirmContext.Provider>
  )
}

/** Returns an async `confirm(opts) => Promise<boolean>`. Must be used within <ConfirmProvider>. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>')
  return ctx
}
