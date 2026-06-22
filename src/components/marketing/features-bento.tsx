import { Inbox, Sparkles, ShieldCheck, Share2, Gauge, KeyRound, Building2, MessagesSquare, BookOpen } from 'lucide-react'
import { Reveal } from './reveal'

const MONO = 'font-[family-name:var(--font-geist-mono)]'
const CARD =
  'group flex h-full flex-col rounded-xl border border-zinc-200 bg-white p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-teal-200 hover:shadow-md hover:shadow-teal-900/5'
const ICON =
  'flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50 text-teal-700 ring-1 ring-teal-100 transition-colors group-hover:bg-teal-600 group-hover:text-white group-hover:ring-teal-600'

const INBOX_ROWS = [
  { dot: '#25d366', name: 'Ava Chen', ch: 'whatsapp' },
  { dot: '#ea4335', name: 'Liam Patel', ch: 'email' },
  { dot: '#6264a7', name: 'Ops team', ch: 'teams' },
  { dot: '#16a34a', name: 'Visitor', ch: 'live-chat' },
]

function Small({
  icon: Icon,
  title,
  body,
  meta,
}: {
  icon: typeof Inbox
  title: string
  body: string
  meta?: React.ReactNode
}) {
  return (
    <div className={CARD}>
      <span className={ICON}>
        <Icon className="h-4 w-4" />
      </span>
      <h3 className="mt-3.5 text-[15px] font-medium text-zinc-900">{title}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-600">{body}</p>
      {meta ? <div className="mt-3">{meta}</div> : null}
    </div>
  )
}

/**
 * Priority-weighted bento — one large cell (the shared inbox, with a live
 * micro-UI fragment) anchors the grid; supporting features fill 1×1 cells, each
 * leading with a concrete data line, not a decorative centered icon. Each cell
 * staggers in on scroll and lifts subtly on hover (the icon chip fills); the
 * inbox panel carries a gentle "live" pulse. Light Console theme, hairline
 * borders. Reveal/hover are reduced-motion-safe via the global reset.
 */
export function FeaturesBento() {
  return (
    <div className="mt-14 grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Marquee cell — shared inbox */}
      <Reveal className="lg:col-span-2 lg:row-span-2">
        <div className={CARD}>
          <div>
            <span className={ICON}>
              <Inbox className="h-4 w-4" />
            </span>
            <h3 className="mt-3.5 text-lg font-medium text-zinc-900">One shared inbox, 8 channels</h3>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-zinc-600">
              Email, Teams, WhatsApp, SMS, Telegram, Messenger, Instagram and website live chat —
              in a single threaded workspace. No more tab-hopping.
            </p>
          </div>
          <div className="mt-5 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
            <div className={`${MONO} mb-2 flex items-center justify-between px-1 text-[11px] text-zinc-500`}>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-teal-500 animate-pulse" />
                all channels · live
              </span>
              <span className="tabular-nums">1,284 open</span>
            </div>
            <div className="space-y-0.5">
              {INBOX_ROWS.map((r, i) => (
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
        </div>
      </Reveal>

      <Reveal delay={60}>
        <Small
          icon={Sparkles}
          title="AI-drafted replies"
          body="A context-aware reply in seconds. Your agent reviews and approves — AI never sends on its own."
          meta={<span className={`${MONO} rounded bg-teal-50 px-2 py-1 text-[11px] text-teal-700`}>approval-gated</span>}
        />
      </Reveal>

      <Reveal delay={120}>
        <Small
          icon={ShieldCheck}
          title="Granular role-based access"
          body="Control who sees which sections, channels, AI features and actions."
          meta={<span className={`${MONO} text-[11px] text-zinc-500`}>per-role · per-user · enforced in DB</span>}
        />
      </Reveal>

      <Reveal delay={90}>
        <Small
          icon={Share2}
          title="Smart routing & assignment"
          body="Conversations land with the right person automatically — assignment, statuses, tags, no collisions."
        />
      </Reveal>

      <Reveal delay={150}>
        <Small
          icon={Gauge}
          title="SLA & CSAT tracking"
          body="See response times, keep promises with SLA timers, measure happiness with CSAT."
          meta={
            <div className={`${MONO} flex items-center gap-2 text-[11px]`}>
              <span className="rounded bg-amber-50 px-2 py-1 tabular-nums text-amber-700">SLA 00:42</span>
              <span className="tabular-nums text-zinc-500">CSAT 4.8/5</span>
            </div>
          }
        />
      </Reveal>

      <Reveal delay={210}>
        <Small
          icon={KeyRound}
          title="Bring your own credentials"
          body="Connect each tenant’s own email, WhatsApp, Twilio, Telegram and Meta accounts."
          meta={<span className={`${MONO} text-[11px] text-zinc-500`}>encrypted · test-gated</span>}
        />
      </Reveal>

      <Reveal delay={120}>
        <Small
          icon={Building2}
          title="Multi-tenant by design"
          body="Run many brands from one platform. Every tenant is isolated at the database level."
          meta={<span className={`${MONO} text-[11px] text-zinc-500`}>row-level security</span>}
        />
      </Reveal>

      <Reveal delay={180}>
        <Small
          icon={MessagesSquare}
          title="Website live chat"
          body="Drop a chat bubble on any site. Visitor chats land in the same inbox, in real time."
          meta={<span className={`${MONO} text-[11px] text-zinc-500`}>&lt;script&gt; · one line</span>}
        />
      </Reveal>

      <Reveal delay={240}>
        <Small
          icon={BookOpen}
          title="Knowledge base & templates"
          body="Reusable reply templates and a shared knowledge base keep answers fast and on-brand."
        />
      </Reveal>
    </div>
  )
}
