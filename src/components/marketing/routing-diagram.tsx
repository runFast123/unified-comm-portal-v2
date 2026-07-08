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

const pathFor = (cy: number) => `M168 ${cy} C 340 ${cy}, 430 ${NODE_CY}, ${NODE_X} ${NODE_CY}`
const cyFor = (i: number) => 39 + i * 44

/**
 * Interactive "eight channels → one inbox" routing diagram (light Console theme).
 * Lines self-draw when scrolled into view, then a steady staggered trickle of
 * channel-coloured message dots flows into the unified inbox. The visitor can
 * hover / focus / tap any channel to light up its route, fire a message along
 * it, and tick the inbox's "routed" counter. Pure SVG + one IntersectionObserver;
 * under reduced-motion the global reset collapses the ambient motion, leaving a
 * clean static (still fully interactive) diagram.
 */
export function RoutingDiagram() {
  const ref = useRef<SVGSVGElement | null>(null)
  const [drawn, setDrawn] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const [routed, setRouted] = useState(0)
  // Announced to screen readers when a route fires — the SVG's static aria-label
  // can't convey the dynamic "N routed" node text.
  const [lastRouted, setLastRouted] = useState<string | null>(null)
  // Hover previews a route; clicking pins it highlighted + routes a message.
  const active = hover ?? pinned

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
  // Click pins the channel + routes a message; clicking the already-pinned
  // channel toggles back to the ambient (unpinned) state.
  const route = (i: number) => {
    const willUnpin = pinned === i
    setPinned(willUnpin ? null : i)
    if (!willUnpin) {
      setRouted((n) => n + 1)
      setLastRouted(CHANNELS[i].label)
    }
  }

  return (
    <div className="overflow-x-auto">
    <svg
      ref={ref}
      viewBox="0 0 700 380"
      className="w-full min-w-[600px]"
      role="img"
      aria-label="Eight channels — email, Teams, WhatsApp, SMS, Telegram, Messenger, Instagram and live chat — converge through routing lines into a single unified inbox. Hover or tap a channel to route a message."
    >
      {/* connector lines — the active channel's route lights up */}
      <g fill="none" strokeLinecap="round">
        {CHANNELS.map((c, i) => {
          const on = active === i
          return (
            <path
              key={c.label}
              d={pathFor(cyFor(i))}
              stroke={on ? '#0f766e' : '#d4d4d8'}
              strokeWidth={on ? 2.5 : 1.5}
              style={{
                strokeDasharray: LEN,
                strokeDashoffset: drawn ? 0 : LEN,
                transition: 'stroke-dashoffset 1.2s cubic-bezier(0.22,1,0.36,1), stroke 0.25s, stroke-width 0.25s',
                transitionDelay: drawn ? '0ms' : `${i * 70}ms`,
              }}
            />
          )
        })}
      </g>

      {/* ambient flowing message dots — one per channel, staggered */}
      {CHANNELS.map((c, i) => (
        <circle
          key={`flow-${c.label}`}
          r={active === i ? 3.6 : 2.6}
          fill={c.dot}
          style={{
            offsetPath: `path('${pathFor(cyFor(i))}')`,
            opacity: 0,
            animation: drawn ? `route-flow ${active === i ? '1.4s' : '3.6s'} ${active === i ? '0s' : `${0.6 + i * 0.4}s`} linear infinite` : 'none',
            transition: 'r 0.2s',
          }}
        />
      ))}

      {/* merge point — gentle "receiving" pulse where channels converge */}
      <circle cx={NODE_X} cy={NODE_CY} r="9" fill="#0f766e" style={{ opacity: 0.18, animation: drawn ? 'merge-glow 2.6s ease-in-out infinite' : 'none' }} />
      <circle cx={NODE_X} cy={NODE_CY} r="3" fill="#0f766e" />

      {/* channel chips — interactive: hover / focus / tap to route a message */}
      {CHANNELS.map((c, i) => {
        const y = cyFor(i) - 15
        const on = active === i
        return (
          <g
            key={c.label}
            role="button"
            tabIndex={0}
            aria-pressed={pinned === i}
            aria-label={`Route a ${c.label} message into the unified inbox`}
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            onClick={() => route(i)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); route(i) } }}
          >
            <rect
              x="8"
              y={y}
              width="160"
              height="30"
              rx="6"
              fill={on ? '#f0fdfa' : '#ffffff'}
              stroke={on ? '#0f766e' : '#e4e4e7'}
              style={{ transition: 'fill 0.2s, stroke 0.2s' }}
            />
            <circle cx="26" cy={y + 15} r="3.5" fill={c.dot} />
            <text x="42" y={y + 19} fontFamily={mono} fontSize="12" fill={on ? '#0f766e' : '#52525b'} style={{ transition: 'fill 0.2s' }}>{c.label}</text>
          </g>
        )
      })}

      {/* unified node */}
      <rect x={NODE_X} y={NODE_CY - 34} width="150" height="68" rx="8" fill="#f0fdfa" stroke="#0f766e" strokeWidth="1.5" />
      <text x={NODE_X + 75} y={NODE_CY - 8} textAnchor="middle" fontSize="15" fontWeight="500" fill="#0f766e">Unified inbox</text>
      <text x={NODE_X + 75} y={NODE_CY + 12} textAnchor="middle" fontFamily={mono} fontSize="10" fill="#71717a">one threaded queue</text>
      <text x={NODE_X + 75} y={NODE_CY + 26} textAnchor="middle" fontFamily={mono} fontSize="10" fill="#0f766e">
        {routed > 0 ? `${routed} routed` : 'hover a channel'}
      </text>
    </svg>
      <span className="sr-only" role="status" aria-live="polite">
        {lastRouted ? `Routed a ${lastRouted} message into the unified inbox — ${routed} routed.` : ''}
      </span>
    </div>
  )
}
