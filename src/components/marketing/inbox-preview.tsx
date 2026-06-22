'use client'

import { useState } from 'react'

const MONO = 'font-[family-name:var(--font-geist-mono)]'

type Row = { dot: string; name: string; ch: string; key: string }

const ROWS: Row[] = [
  { dot: '#25d366', name: 'Ava Chen', ch: 'whatsapp', key: 'whatsapp' },
  { dot: '#ea4335', name: 'Liam Patel', ch: 'email', key: 'email' },
  { dot: '#6264a7', name: 'Ops team', ch: 'teams', key: 'teams' },
  { dot: '#16a34a', name: 'Website visitor', ch: 'live-chat', key: 'livechat' },
  { dot: '#25d366', name: 'Noah Kim', ch: 'whatsapp', key: 'whatsapp' },
  { dot: '#ea4335', name: 'Mara Voss', ch: 'email', key: 'email' },
  { dot: '#0088cc', name: 'Sana Iqbal', ch: 'telegram', key: 'telegram' },
]

const FILTERS = [
  { key: 'all', label: 'all', open: 1284 },
  { key: 'whatsapp', label: 'whatsapp', open: 312 },
  { key: 'email', label: 'email', open: 488 },
  { key: 'teams', label: 'teams', open: 96 },
  { key: 'livechat', label: 'live chat', open: 174 },
  { key: 'telegram', label: 'telegram', open: 58 },
]

/**
 * Interactive shared-inbox preview for the bento's marquee cell. Channel filter
 * chips let the visitor narrow the unified queue to one channel; the row list
 * and the "open" count update live. A gentle "live" pulse on the header.
 */
export function InboxPreview() {
  const [filter, setFilter] = useState('all')
  const rows = filter === 'all' ? ROWS : ROWS.filter((r) => r.key === filter)
  const meta = FILTERS.find((f) => f.key === filter) ?? FILTERS[0]

  return (
    <div className="flex h-full flex-col rounded-lg border border-zinc-200 bg-zinc-50 p-3">
      <div className={`${MONO} mb-2 flex items-center justify-between px-1 text-[11px] text-zinc-500`}>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-teal-500 animate-pulse" />
          {meta.label} · live
        </span>
        <span className="tabular-nums">{meta.open.toLocaleString()} open</span>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {FILTERS.map((f) => {
          const on = f.key === filter
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={on}
              className={`${MONO} rounded-md px-2 py-0.5 text-[10px] transition-colors ${
                on ? 'bg-teal-600 text-white' : 'border border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-800'
              }`}
            >
              {f.label}
            </button>
          )
        })}
      </div>

      <div className="space-y-0.5">
        {rows.map((r, i) => (
          <div
            key={r.name}
            className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 ${i === 0 ? 'border-l-2 border-teal-600 bg-white' : 'border-l-2 border-transparent'}`}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: r.dot }} />
            <span className="flex-1 truncate text-[12px] font-medium text-zinc-800">{r.name}</span>
            <span className={`${MONO} text-[10px] text-zinc-500`}>{r.ch}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
