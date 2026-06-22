import { Bot } from 'lucide-react'

const MONO = 'font-[family-name:var(--font-geist-mono)]'

const ROWS = [
  { dot: '#25d366', name: 'Ava Chen', ch: 'whatsapp', id: '#4821', t: '2m', active: true },
  { dot: '#ea4335', name: 'Liam Patel', ch: 'email', id: '#4822', t: '6m' },
  { dot: '#16a34a', name: 'Website visitor', ch: 'live-chat', id: '#4823', t: '9m' },
  { dot: '#6264a7', name: 'Ops team', ch: 'teams', id: '#4824', t: '14m' },
  { dot: '#0088cc', name: 'Mara Voss', ch: 'telegram', id: '#4825', t: '21m' },
]

/**
 * Dimensional product composition for the hero — two real UI panels (an
 * all-channels inbox behind, a thread + AI-draft in front) layered in a CSS 3D
 * scene at a three-quarter angle. Replaces the rejected glowing orb: the hero
 * now *contains the product* rather than an abstraction of it. Depth comes from
 * a surface ladder + hairline borders, not glow. Server-rendered; the one-time
 * staggered assembly uses `.animate-rise` (the global reduced-motion reset
 * collapses it to an instant, already-assembled end state).
 */
export function HeroPanels() {
  return (
    <div className="relative [perspective:1800px]" aria-hidden="true">
      <div className="relative [transform-style:preserve-3d] [transform:rotateY(-11deg)_rotateX(3deg)] sm:[transform:rotateY(-13deg)_rotateX(4deg)]">
        {/* Back panel — all-channels inbox */}
        <div className="animate-rise rounded-xl border border-white/10 bg-[#141416] p-3">
          <div className="mb-2.5 flex items-center justify-between px-1">
            <span className={`${MONO} text-[11px] tracking-tight text-zinc-500`}>inbox · 8 channels</span>
            <span className={`${MONO} text-[11px] tabular-nums text-zinc-500`}>1,284 open</span>
          </div>
          <div className="space-y-0.5">
            {ROWS.map((r) => (
              <div
                key={r.id}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 ${
                  r.active ? 'border-l-2 border-teal-400 bg-white/[0.05]' : 'border-l-2 border-transparent'
                }`}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: r.dot }} />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-200">{r.name}</span>
                <span className={`${MONO} hidden text-[10px] text-zinc-500 sm:inline`}>{r.ch}</span>
                <span className={`${MONO} text-[10px] tabular-nums text-zinc-600`}>{r.id}</span>
                <span className={`${MONO} w-7 text-right text-[10px] tabular-nums text-zinc-600`}>{r.t}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Front panel — thread + AI draft, pushed forward in Z */}
        <div className="animate-rise absolute -bottom-12 -left-6 w-[78%] rounded-xl border border-white/15 bg-[#1b1b1f] p-3.5 shadow-2xl shadow-black/50 [animation-delay:160ms] [transform:translateZ(70px)] sm:-left-10">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-zinc-200">Ava Chen</span>
            <span className={`${MONO} rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] tabular-nums text-amber-300`}>SLA 00:42</span>
          </div>
          <div className="mt-2.5 space-y-2">
            <div className="max-w-[88%] rounded-lg rounded-tl-sm bg-white/[0.06] px-2.5 py-1.5 text-[11px] leading-snug text-zinc-300">
              My order #4821 arrived damaged — can I get a refund?
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-teal-400/20 bg-teal-400/[0.06] p-2.5">
            <div className="flex items-center gap-1.5 text-[10px] font-medium text-teal-300">
              <Bot className="h-3 w-3" /> AI draft · review before send
            </div>
            <p className="mt-1 text-[11px] leading-snug text-zinc-400">
              So sorry, Ava — I’ve started a full refund and emailed a prepaid return label…
            </p>
            <div className="mt-2 flex gap-1.5">
              <span className="rounded-md bg-teal-600 px-2 py-1 text-[10px] font-medium text-white">Approve &amp; send</span>
              <span className="rounded-md border border-white/15 px-2 py-1 text-[10px] font-medium text-zinc-400">Edit</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
