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

const NODE_X = 540
const NODE_CY = 193
const LEN = 640

// Each channel's connector path — a smooth S-curve from the chip's right edge
// into the single merge point at the inbox node's left-centre.
const pathFor = (cy: number) => `M168 ${cy} C 340 ${cy}, 430 ${NODE_CY}, ${NODE_X} ${NODE_CY}`
const cyFor = (i: number) => 39 + i * 44

/**
 * "Eight channels → one inbox" routing diagram (light Console theme). The
 * connector lines self-draw when the diagram scrolls into view; then a steady,
 * staggered trickle of channel-coloured message dots flows along every path
 * into the unified inbox, with a gentle pulse at the merge point — motion that
 * encodes the product's real data flow. Pure SVG + one IntersectionObserver;
 * under reduced-motion the global reset collapses every animation, leaving the
 * drawn lines + node as a clean static end state.
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
      {/* connector lines (drawn first, behind the chips/node) */}
      <g fill="none" stroke="#d4d4d8" strokeWidth="1.5" strokeLinecap="round">
        {CHANNELS.map((c, i) => (
          <path
            key={c.label}
            d={pathFor(cyFor(i))}
            style={{
              strokeDasharray: LEN,
              strokeDashoffset: drawn ? 0 : LEN,
              transition: 'stroke-dashoffset 1.2s cubic-bezier(0.22,1,0.36,1)',
              transitionDelay: `${i * 70}ms`,
            }}
          />
        ))}
      </g>

      {/* flowing message dots — one per channel, staggered, channel-coloured */}
      {CHANNELS.map((c, i) => (
        <circle
          key={`flow-${c.label}`}
          r="2.6"
          fill={c.dot}
          style={{
            offsetPath: `path('${pathFor(cyFor(i))}')`,
            opacity: 0,
            animation: drawn ? `route-flow 3.6s ${0.6 + i * 0.4}s linear infinite` : 'none',
          }}
        />
      ))}

      {/* merge point — gentle "receiving" pulse where channels converge */}
      <circle
        cx={NODE_X}
        cy={NODE_CY}
        r="9"
        fill="#0f766e"
        style={{ opacity: 0.18, animation: drawn ? 'merge-glow 2.6s ease-in-out infinite' : 'none' }}
      />
      <circle cx={NODE_X} cy={NODE_CY} r="3" fill="#0f766e" />

      {/* channel chips */}
      {CHANNELS.map((c, i) => {
        const y = cyFor(i) - 15
        return (
          <g key={c.label}>
            <rect x="8" y={y} width="160" height="30" rx="6" fill="#ffffff" stroke="#e4e4e7" />
            <circle cx="26" cy={y + 15} r="3.5" fill={c.dot} />
            <text x="42" y={y + 19} fontFamily={mono} fontSize="12" fill="#52525b">{c.label}</text>
          </g>
        )
      })}

      {/* unified node */}
      <rect x={NODE_X} y={NODE_CY - 34} width="150" height="68" rx="8" fill="#f0fdfa" stroke="#0f766e" strokeWidth="1.5" />
      <text x={NODE_X + 75} y={NODE_CY - 6} textAnchor="middle" fontSize="15" fontWeight="500" fill="#0f766e">Unified inbox</text>
      <text x={NODE_X + 75} y={NODE_CY + 16} textAnchor="middle" fontFamily={mono} fontSize="11" fill="#71717a">one threaded queue</text>
    </svg>
  )
}
