'use client'

import { useEffect, useState } from 'react'
import { Bot, Check, MousePointerClick } from 'lucide-react'

const MONO = 'font-[family-name:var(--font-geist-mono)]'

type Convo = {
  dot: string
  name: string
  ch: string
  id: string
  t: string
  msg: string
  draft: string
}

const CONVOS: Convo[] = [
  { dot: '#25d366', name: 'Ava Chen', ch: 'whatsapp', id: '#4821', t: '2m', msg: 'My order #4821 arrived damaged — can I get a refund?', draft: 'So sorry, Ava — I’ve started a full refund and emailed a prepaid return label. It’ll land in 3–5 days.' },
  { dot: '#ea4335', name: 'Liam Patel', ch: 'email', id: '#4822', t: '6m', msg: 'Where is my delivery? It was due yesterday.', draft: 'Hi Liam — your parcel is out for delivery today and should arrive by 5pm. Here’s the live tracking link.' },
  { dot: '#16a34a', name: 'Website visitor', ch: 'live-chat', id: '#4823', t: '9m', msg: 'Is the X200 in stock?', draft: 'Yes — the X200 is in stock and ships same-day on orders before 3pm. Want me to hold one for you?' },
  { dot: '#6264a7', name: 'Ops team', ch: 'teams', id: '#4824', t: '14m', msg: 'Escalation: VIP account waiting on a callback.', draft: 'On it — I’ve flagged this VIP thread and assigned it to the on-call lead for an immediate callback.' },
  { dot: '#0088cc', name: 'Mara Voss', ch: 'telegram', id: '#4825', t: '21m', msg: 'Can I change my subscription plan?', draft: 'Absolutely, Mara — I can move you to the annual plan now and prorate the difference. Want me to apply it?' },
]

/**
 * Interactive product hero. The back panel is a clickable all-channels inbox;
 * selecting a row updates the front panel's conversation + AI draft. "Approve &
 * send" shows a sent state. The composition sits at a product-shot angle and
 * straightens once the visitor starts interacting. It gently auto-advances on
 * load to hint it's interactive, then yields on first interaction. Reduced
 * motion: no auto-advance + the global reset neutralises transitions (it stays
 * a readable, already-assembled static demo).
 */
export function HeroPanels() {
  const [active, setActive] = useState(0)
  const [sent, setSent] = useState(false)
  const [took, setTook] = useState(false)

  useEffect(() => {
    if (took) return
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const id = window.setInterval(() => setActive((a) => (a + 1) % CONVOS.length), 4000)
    return () => window.clearInterval(id)
  }, [took])

  const select = (i: number) => {
    setTook(true)
    setActive(i)
    setSent(false)
  }

  const c = CONVOS[active]

  return (
    <div className="relative [perspective:1800px]">
      <div
        className="relative [transform-style:preserve-3d]"
        style={{
          transform: took ? 'rotateY(-3deg) rotateX(1deg)' : 'rotateY(-9deg) rotateX(3deg)',
          transition: 'transform 0.6s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {/* Back panel — clickable all-channels inbox */}
        <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
          <div className="mb-2.5 flex items-center justify-between px-1">
            <span className={`${MONO} inline-flex items-center gap-1.5 text-[11px] tracking-tight text-zinc-500`}>
              <span className="h-1.5 w-1.5 rounded-full bg-teal-500 animate-pulse" />
              inbox · 8 channels
            </span>
            <span className={`${MONO} text-[11px] tabular-nums text-zinc-500`}>1,284 open</span>
          </div>
          <div className="space-y-0.5">
            {CONVOS.map((r, i) => {
              const on = i === active
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => select(i)}
                  aria-pressed={on}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                    on ? 'border-l-2 border-teal-600 bg-teal-50/70' : 'border-l-2 border-transparent hover:bg-zinc-50'
                  }`}
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: r.dot }} />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-800">{r.name}</span>
                  <span className={`${MONO} hidden text-[10px] text-zinc-500 sm:inline`}>{r.ch}</span>
                  <span className={`${MONO} text-[10px] tabular-nums text-zinc-400`}>{r.id}</span>
                  <span className={`${MONO} w-7 text-right text-[10px] tabular-nums text-zinc-400`}>{r.t}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Front panel — the selected conversation + AI draft */}
        <div className="absolute -bottom-12 -left-6 w-[80%] rounded-xl border border-zinc-200 bg-white p-3.5 shadow-xl shadow-zinc-300/40 [transform:translateZ(70px)] sm:-left-10">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-[12px] font-medium text-zinc-800">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.dot }} />
              {c.name}
              <span className={`${MONO} text-[10px] font-normal text-zinc-400`}>{c.ch}</span>
            </span>
            <span className={`${MONO} rounded bg-amber-50 px-1.5 py-0.5 text-[10px] tabular-nums text-amber-700`}>SLA 00:42</span>
          </div>

          <div key={active} className="animate-fade-in">
            <div className="mt-2.5">
              <div className="max-w-[88%] rounded-lg rounded-tl-sm bg-zinc-100 px-2.5 py-1.5 text-[11px] leading-snug text-zinc-700">
                {c.msg}
              </div>
            </div>
            {sent ? (
              <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 p-2.5 text-[11px] font-medium text-teal-700">
                <Check className="h-3.5 w-3.5" /> Sent · just now
              </div>
            ) : (
              <div className="mt-3 rounded-lg border border-teal-200 bg-teal-50/70 p-2.5">
                <div className="flex items-center gap-1.5 text-[10px] font-medium text-teal-700">
                  <Bot className="h-3 w-3" /> AI draft · review before send
                </div>
                <p className="mt-1 text-[11px] leading-snug text-zinc-600">{c.draft}</p>
                <div className="mt-2 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => { setTook(true); setSent(true) }}
                    className="rounded-md bg-teal-600 px-2 py-1 text-[10px] font-medium text-white transition-colors hover:bg-teal-700"
                  >
                    Approve &amp; send
                  </button>
                  <span aria-hidden="true" className="rounded-md border border-zinc-200 px-2 py-1 text-[10px] font-medium text-zinc-500">Edit</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* interaction hint — fades out once the visitor engages */}
      <div
        className={`${MONO} pointer-events-none absolute -bottom-4 right-0 inline-flex items-center gap-1.5 text-[11px] text-zinc-400 transition-opacity duration-500 ${took ? 'opacity-0' : 'opacity-100'}`}
        aria-hidden="true"
      >
        <MousePointerClick className="h-3.5 w-3.5" /> click a conversation
      </div>
    </div>
  )
}
