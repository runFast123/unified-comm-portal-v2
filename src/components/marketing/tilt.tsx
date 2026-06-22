'use client'

import { useRef, useCallback } from 'react'

/**
 * Mouse-tracking 3D perspective tilt — a lightweight, dependency-free
 * "modern depth" wrapper for marketing/login cards and mockups. Writes the
 * transform imperatively (no re-render per mousemove) for 60fps, and is a
 * no-op under prefers-reduced-motion. Children that should lift on tilt can use
 * `translateZ` via their own classes inside a `transform-style: preserve-3d`.
 */
export function Tilt({
  children,
  className,
  max = 8,
}: {
  children: React.ReactNode
  className?: string
  /** Max tilt in degrees on each axis. */
  max?: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  const onMove = useCallback(
    (e: React.MouseEvent) => {
      const el = ref.current
      if (!el) return
      if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
      const r = el.getBoundingClientRect()
      const rx = (0.5 - (e.clientY - r.top) / r.height) * max * 2
      const ry = ((e.clientX - r.left) / r.width - 0.5) * max * 2
      el.style.transform = `perspective(1100px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`
    },
    [max]
  )

  const onLeave = useCallback(() => {
    const el = ref.current
    if (el) el.style.transform = 'perspective(1100px) rotateX(0deg) rotateY(0deg)'
  }, [])

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={className}
      style={{
        transition: 'transform 0.3s cubic-bezier(0.16,1,0.3,1)',
        transformStyle: 'preserve-3d',
        willChange: 'transform',
      }}
    >
      {children}
    </div>
  )
}
