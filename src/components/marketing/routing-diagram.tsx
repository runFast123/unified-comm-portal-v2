'use client'

import { useEffect, useRef, useState } from 'react'

const CHANNELS = [
  { label: 'email', dot: '#ea4335' },
  { label: 'teams', dot: '#6264a7' },
  { label: 'whatsapp', dot: '#25d366' },
  { label: 'sms', dot: '#ec4899' },
  { label: 'telegram', dot: '#0088cc' },
  { label: 'messenger', dot: '#0084ff' },
  { label: 'instagram', dot: '#e4405f' },
  { label: 'live chat', dot: '#16a34a' },
]

const NODE_X = 470
const NODE_CY = 190
const LEN = 640

/**
 * "Eight channels → one inbox" routing diagram. The connector lines self-draw
 * (stroke-dashoffset) when the diagram scrolls into view, then settle — motion
 * that encodes the product's actual data flow, not décor. Pure SVG + one
 * IntersectionObserver; under reduced-motion the global reset collapses the
 * transition so the lines render already drawn. Lives on the dark marketing
 * canvas, so fills are fixed light values.
 */
export function RoutingDiagram() {
  const ref = useRef<SVGSVGElement | null>(null)
  const [drawn, setDrawn] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setDrawn(true)
      return
    }
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) {
          setDrawn(true)
          obs.disconnect()
        }
      }),
      { threshold: 0.35 },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const mono = 'var(--font-geist-mono)'

  return (
    <svg
      ref={ref}
      viewBox="0 0 700 380"
      className="w-full"
      role="img"
      aria-label="Eight channels — email, Teams, WhatsApp, SMS, Telegram, Messenger, Instagram and live chat — converge through routing lines into a single unified inbox."
    >
      {/* connector lines (drawn first, sit behind the chips/node) */}
      <g fill="none" stroke="#3f3f46" strokeWidth="1.5">
        {CHANNELS.map((c, i) => {
          const y = 28 + i * 44
          const d = `M168 ${y + 15} C 300 ${y + 15}, 320 ${NODE_CY}, ${NODE_X} ${NODE_CY}`
          return (
            <path
              key={c.label}
              d={d}
              style={{
                strokeDasharray: LEN,
                strokeDashoffset: drawn ? 0 : LEN,
                transition: 'stroke-dashoffset 1.1s cubic-bezier(0.16,1,0.3,1)',
                transitionDelay: `${i * 85}ms`,
              }}
            />
          )
        })}
      </g>

      {/* a single message travelling the active (WhatsApp) path */}
      <circle r="3.5" fill="#2dd4bf" style={{ offsetPath: `path('M168 103 C 300 103, 320 ${NODE_CY}, ${NODE_X} ${NODE_CY}')`, animation: drawn ? 'route-dot 2.6s 1.2s ease-in-out infinite' : 'none' }} />

      {/* channel chips */}
      {CHANNELS.map((c, i) => {
        const y = 28 + i * 44
        return (
          <g key={c.label}>
            <rect x="8" y={y} width="160" height="30" rx="6" fill="#141416" stroke="rgba(255,255,255,0.08)" />
            <circle cx="26" cy={y + 15} r="3.5" fill={c.dot} />
            <text x="42" y={y + 19} fontFamily={mono} fontSize="12" fill="#a1a1aa">{c.label}</text>
          </g>
        )
      })}

      {/* unified node */}
      <rect x={NODE_X} y={NODE_CY - 34} width="180" height="68" rx="8" fill="#10201d" stroke="#2dd4bf" strokeWidth="1.5" />
      <text x={NODE_X + 90} y={NODE_CY - 6} textAnchor="middle" fontSize="15" fontWeight="500" fill="#5eead4">Unified inbox</text>
      <text x={NODE_X + 90} y={NODE_CY + 16} textAnchor="middle" fontFamily={mono} fontSize="11" fill="#71717a">one threaded queue</text>
    </svg>
  )
}
