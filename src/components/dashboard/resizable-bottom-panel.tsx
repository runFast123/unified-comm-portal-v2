'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

const MIN_H = 100
const MAX_H = 560
const LS_H = 'conv.bottom.height'

/**
 * Height-adjustable shell for the conversation's lower region (suggested replies
 * + scheduled messages). The message thread above flexes to fill whatever space
 * this doesn't take, so dragging the handle reallocates vertical room between
 * the thread and this panel.
 *
 *   - Desktop (lg+): a row-resize handle on top; default height is `auto`
 *     (content-sized, the original look) until you drag, then it's a fixed,
 *     scrollable height persisted in localStorage. Double-click the handle to
 *     reset to auto.
 *   - Below lg / SSR + first paint: natural content flow, no handle (no
 *     hydration mismatch).
 *
 * The conversation ACTION BAR stays OUTSIDE this panel (pinned by the page) so
 * its buttons can never scroll out of view.
 */
export function ResizableBottomPanel({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)
  const [height, setHeight] = useState<number | null>(null) // null = auto
  const [isDesktop, setIsDesktop] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const h = Number(localStorage.getItem(LS_H))
      if (Number.isFinite(h) && h >= MIN_H && h <= MAX_H) setHeight(h)
    } catch {
      /* ignore */
    }
    const mq = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    setMounted(true)
    return () => mq.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!mounted) return
    try {
      if (height != null) localStorage.setItem(LS_H, String(height))
      else localStorage.removeItem(LS_H)
    } catch {
      /* ignore */
    }
  }, [height, mounted])

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startY = e.clientY
      // Seed from the current rendered height the first time (height === null).
      const startH = height ?? ref.current?.offsetHeight ?? MIN_H
      const onMove = (ev: MouseEvent) => {
        // Handle is on top, so dragging UP (smaller clientY) makes it taller.
        const next = Math.min(MAX_H, Math.max(MIN_H, startH + (startY - ev.clientY)))
        setHeight(next)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [height]
  )

  const sized = mounted && isDesktop && height != null

  return (
    <div
      ref={ref}
      className="relative flex shrink-0 flex-col"
      style={sized ? { height: height as number } : undefined}
    >
      {mounted && isDesktop && (
        <div
          onMouseDown={startResize}
          onDoubleClick={() => setHeight(null)}
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize · double-click to reset"
          className="group flex h-2.5 shrink-0 cursor-row-resize items-center justify-center border-t border-gray-200 bg-white transition-colors hover:bg-teal-50"
        >
          <span className="h-1 w-10 rounded-full bg-gray-300 transition-colors group-hover:bg-teal-400" />
        </div>
      )}
      <div className={sized ? 'min-h-0 flex-1 overflow-y-auto' : undefined}>{children}</div>
    </div>
  )
}
