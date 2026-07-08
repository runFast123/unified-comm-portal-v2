'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Number that counts up from 0 to `to` the first time it scrolls into view
 * (cubic ease-out). Used for the stats band. No dependency — requestAnimationFrame.
 */
export function CountUp({
  to,
  duration = 1600,
  decimals = 0,
  prefix = '',
  suffix = '',
  className = '',
}: {
  to: number
  duration?: number
  decimals?: number
  prefix?: string
  suffix?: string
  className?: string
}) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [val, setVal] = useState(0)
  const started = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Respect prefers-reduced-motion: the global CSS reset only neutralises CSS
    // animation, not this JS requestAnimationFrame counter — jump to the final
    // value instead of ticking (mirrors the guard in hero-panels/routing-diagram).
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setVal(to)
      return
    }
    const run = () => {
      if (started.current) return
      started.current = true
      const t0 = performance.now()
      const tick = (now: number) => {
        const p = Math.min((now - t0) / duration, 1)
        const eased = 1 - Math.pow(1 - p, 3)
        setVal(to * eased)
        if (p < 1) requestAnimationFrame(tick)
        else setVal(to)
      }
      requestAnimationFrame(tick)
    }
    if (typeof IntersectionObserver === 'undefined') {
      run()
      return
    }
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && run()),
      { threshold: 0.4 },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [to, duration])

  return (
    <span ref={ref} className={className}>
      {prefix}
      {val.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  )
}
