'use client'

import { useState, useEffect, useCallback } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'

const MIN_W = 300
const MAX_W = 640
const DEFAULT_W = 384 // matches the previous fixed lg:w-96 (384px)
const LS_W = 'conv.sidebar.width'
const LS_COLLAPSED = 'conv.sidebar.collapsed'

/**
 * Desktop resizable + collapsible shell around the conversation AI side panel.
 *
 *   - lg and up: a flex column whose width is drag-adjustable (300–640px) and
 *     which can collapse to a thin rail. Width + collapsed state persist per
 *     browser in localStorage.
 *   - below lg: the original full-width stacked layout (no resize / collapse) —
 *     the panel sits BELOW the thread there, so it isn't competing for room.
 *
 * Renders the original static `w-full lg:w-96` shell on the server + first
 * client paint, then upgrades after mount — so there's no hydration mismatch and
 * no layout flash before localStorage is read.
 */
export function ConversationSidebarShell({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [width, setWidth] = useState(DEFAULT_W)
  const [isDesktop, setIsDesktop] = useState(false)

  // Hydrate persisted state + track the lg breakpoint.
  useEffect(() => {
    try {
      const w = Number(localStorage.getItem(LS_W))
      if (Number.isFinite(w) && w >= MIN_W && w <= MAX_W) setWidth(w)
      if (localStorage.getItem(LS_COLLAPSED) === '1') setCollapsed(true)
    } catch {
      /* ignore unavailable storage */
    }
    const mq = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    setMounted(true)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Persist after mount (cheap; localStorage writes are synchronous + fast).
  useEffect(() => {
    if (!mounted) return
    try {
      localStorage.setItem(LS_W, String(width))
      localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [width, collapsed, mounted])

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = width
      const onMove = (ev: MouseEvent) => {
        // The sidebar sits on the right, so dragging its left edge LEFTward
        // (decreasing clientX) makes it wider.
        const next = Math.min(MAX_W, Math.max(MIN_W, startW + (startX - ev.clientX)))
        setWidth(next)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [width]
  )

  // Server + first client paint: identical to the previous static markup.
  if (!mounted) {
    return (
      <div className="w-full lg:w-96 shrink-0 overflow-hidden border-t lg:border-t-0 lg:border-l border-gray-200 bg-white">
        {children}
      </div>
    )
  }

  // Desktop + collapsed → thin rail with an expand button.
  if (isDesktop && collapsed) {
    return (
      <div className="hidden lg:flex w-10 shrink-0 items-start justify-center border-l border-gray-200 bg-white pt-3">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Show AI panel"
          aria-label="Show AI panel"
          className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      </div>
    )
  }

  return (
    <div
      className="relative w-full shrink-0 overflow-hidden border-t lg:border-t-0 lg:border-l border-gray-200 bg-white"
      style={isDesktop ? { width } : undefined}
    >
      {isDesktop && (
        <>
          {/* Drag-to-resize handle along the left edge. */}
          <div
            onMouseDown={startResize}
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
            className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize transition-colors hover:bg-teal-400/50"
          />
          {/* Collapse button, centered on the divider. */}
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Hide AI panel"
            aria-label="Hide AI panel"
            className="absolute left-0 top-1/2 z-20 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-400 shadow-sm transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      {children}
    </div>
  )
}
