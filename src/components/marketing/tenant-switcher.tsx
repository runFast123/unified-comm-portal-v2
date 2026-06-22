'use client'

import { useState } from 'react'
import { Lock, Check } from 'lucide-react'

const MONO = 'font-[family-name:var(--font-geist-mono)]'

const BRANDS = [
  { name: 'Northwind Retail', short: 'NR', color: '#0f766e', open: 312, agents: 8, channels: ['WhatsApp', 'Email', 'Live chat'] },
  { name: 'Acme SaaS', short: 'AS', color: '#4f46e5', open: 178, agents: 5, channels: ['Email', 'Teams', 'Telegram'] },
  { name: 'Globex Travel', short: 'GT', color: '#b45309', open: 96, agents: 4, channels: ['WhatsApp', 'SMS', 'Instagram'] },
]

/**
 * Interactive multi-tenant demo. Click a brand to switch the active tenant; the
 * workspace panel shows that brand's own isolated data (open conversations,
 * agents, connected channels) — making "data never crosses tenants" tangible.
 * Light Console theme; keyboard-accessible.
 */
export function TenantSwitcher() {
  const [active, setActive] = useState(0)
  const b = BRANDS[active]
  const others = BRANDS.filter((_, i) => i !== active).map((x) => x.name)

  return (
    <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6">
      <div className="space-y-3">
        {BRANDS.map((brand, i) => {
          const on = i === active
          return (
            <button
              key={brand.name}
              type="button"
              onClick={() => setActive(i)}
              aria-pressed={on}
              style={{ marginLeft: `${i * 14}px` }}
              className={`flex w-full items-center justify-between rounded-xl border p-4 text-left transition-all ${
                on ? 'border-teal-500 bg-white shadow-sm' : 'border-zinc-200 bg-white hover:border-zinc-300'
              }`}
            >
              <div className="flex items-center gap-3">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[11px] font-semibold text-white"
                  style={{ backgroundColor: brand.color }}
                >
                  {brand.short}
                </span>
                <div>
                  <p className="text-sm font-medium text-zinc-800">{brand.name}</p>
                  <p className={`${MONO} text-[11px] text-zinc-500`}>isolated workspace</p>
                </div>
              </div>
              {on ? <Check className="h-4 w-4 text-teal-700" /> : <Lock className="h-4 w-4 text-zinc-400" />}
            </button>
          )
        })}
      </div>

      {/* Active tenant's isolated workspace */}
      <div key={active} className="animate-fade-in mt-4 rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-zinc-800">{b.name}</span>
          <span className={`${MONO} inline-flex items-center gap-1.5 text-[11px] text-teal-700`}>
            <Lock className="h-3 w-3" /> isolated
          </span>
        </div>
        <div className={`${MONO} mt-3 grid grid-cols-3 gap-2 text-center`}>
          <div className="rounded-lg bg-zinc-50 py-2">
            <div className="text-base tabular-nums text-zinc-900">{b.open.toLocaleString()}</div>
            <div className="text-[10px] text-zinc-500">open</div>
          </div>
          <div className="rounded-lg bg-zinc-50 py-2">
            <div className="text-base tabular-nums text-zinc-900">{b.agents}</div>
            <div className="text-[10px] text-zinc-500">agents</div>
          </div>
          <div className="rounded-lg bg-zinc-50 py-2">
            <div className="text-base tabular-nums text-zinc-900">{b.channels.length}</div>
            <div className="text-[10px] text-zinc-500">channels</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {b.channels.map((c) => (
            <span key={c} className={`${MONO} rounded bg-teal-50 px-2 py-0.5 text-[10px] text-teal-700`}>{c}</span>
          ))}
        </div>
      </div>

      <p className={`${MONO} mt-4 text-center text-[11px] text-zinc-500`}>
        {b.name} can’t see {others.join(' or ')} — data never crosses tenants.
      </p>
    </div>
  )
}
