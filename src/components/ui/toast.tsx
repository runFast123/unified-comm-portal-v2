'use client'

import React, { createContext, useCallback, useContext, useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type ToastType = 'success' | 'error' | 'warning' | 'info'

interface ToastItem {
  id: string
  type: ToastType
  message: string
  duration: number
}

interface ToastAPI {
  success: (message: string, duration?: number) => void
  error: (message: string, duration?: number) => void
  warning: (message: string, duration?: number) => void
  info: (message: string, duration?: number) => void
  dismiss: (id: string) => void
}

interface ToastContextValue {
  toast: ToastAPI
}

/* -------------------------------------------------------------------------- */
/*  Config                                                                    */
/* -------------------------------------------------------------------------- */

const DEFAULT_DURATION = 4000

const typeConfig: Record<
  ToastType,
  { icon: React.ElementType; bg: string; border: string; text: string; iconColor: string }
> = {
  success: {
    icon: CheckCircle2,
    bg: 'bg-teal-50',
    border: 'border-teal-200',
    text: 'text-teal-900',
    iconColor: 'text-teal-600',
  },
  error: {
    icon: XCircle,
    bg: 'bg-red-50',
    border: 'border-red-200',
    text: 'text-red-900',
    iconColor: 'text-red-600',
  },
  warning: {
    icon: AlertTriangle,
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    text: 'text-amber-900',
    iconColor: 'text-amber-600',
  },
  info: {
    icon: Info,
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    text: 'text-blue-900',
    iconColor: 'text-blue-600',
  },
}

/* -------------------------------------------------------------------------- */
/*  Context                                                                   */
/* -------------------------------------------------------------------------- */

const ToastContext = createContext<ToastContextValue | null>(null)

/* -------------------------------------------------------------------------- */
/*  Single toast                                                              */
/* -------------------------------------------------------------------------- */

function Toast({
  item,
  onDismiss,
}: {
  item: ToastItem
  onDismiss: (id: string) => void
}) {
  const [visible, setVisible] = useState(false)
  const [exiting, setExiting] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const config = typeConfig[item.type]
  const Icon = config.icon

  // Slide in on mount
  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  // Auto-dismiss
  useEffect(() => {
    timerRef.current = setTimeout(() => {
      setExiting(true)
    }, item.duration)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [item.duration])

  // After exit animation, remove from list
  useEffect(() => {
    if (exiting) {
      const t = setTimeout(() => onDismiss(item.id), 300)
      return () => clearTimeout(t)
    }
  }, [exiting, item.id, onDismiss])

  const handleClose = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setExiting(true)
  }

  return (
    <div
      role="alert"
      className={cn(
        'pointer-events-auto flex w-80 items-start gap-3 rounded-lg border px-4 py-3 shadow-lg transition-all duration-300',
        config.bg,
        config.border,
        visible && !exiting
          ? 'translate-x-0 opacity-100'
          : 'translate-x-full opacity-0'
      )}
    >
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', config.iconColor)} />
      <p className={cn('flex-1 text-sm font-medium leading-snug', config.text)}>
        {item.message}
      </p>
      <button
        onClick={handleClose}
        className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-black/5 hover:text-gray-600 transition-colors"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Provider                                                                  */
/* -------------------------------------------------------------------------- */

let idCounter = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const addToast = useCallback((type: ToastType, message: string, duration = DEFAULT_DURATION) => {
    const id = `toast-${++idCounter}-${Date.now()}`
    setToasts((prev) => [...prev, { id, type, message, duration }])
  }, [])

  const toast: ToastAPI = React.useMemo(
    () => ({
      success: (message, duration) => addToast('success', message, duration),
      error: (message, duration) => addToast('error', message, duration),
      warning: (message, duration) => addToast('warning', message, duration),
      info: (message, duration) => addToast('info', message, duration),
      dismiss,
    }),
    [addToast, dismiss]
  )

  const value = React.useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {mounted &&
        createPortal(
          <div
            aria-live="polite"
            aria-label="Notifications"
            className="pointer-events-none fixed right-4 top-4 z-[100] flex flex-col gap-2"
          >
            {toasts.map((item) => (
              <Toast key={item.id} item={item} onDismiss={dismiss} />
            ))}
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  )
}

/* -------------------------------------------------------------------------- */
/*  Hook                                                                      */
/* -------------------------------------------------------------------------- */

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within a <ToastProvider>')
  }
  return ctx
}
