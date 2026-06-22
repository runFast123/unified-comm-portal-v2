'use client'

import { useEffect, useState } from 'react'
import {
  Inbox,
  Sparkles,
  MessagesSquare,
  Share2,
  ShieldCheck,
  KeyRound,
  Gauge,
  BookOpen,
  Building2,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Feature = { icon: LucideIcon; title: string; body: string }

const FEATURES: Feature[] = [
  { icon: Inbox, title: 'One shared inbox, 8 channels', body: 'Email, Teams, WhatsApp, SMS, Telegram, Messenger, Instagram and website live chat — in a single threaded workspace. No more tab-hopping.' },
  { icon: Sparkles, title: 'AI-drafted replies', body: 'The assistant writes a context-aware reply in seconds. Your agent reviews and approves — AI never sends on its own.' },
  { icon: MessagesSquare, title: 'Website live chat', body: 'Drop a chat bubble on any site with one line of code. Visitor chats land in the same inbox; your replies stream back in real time.' },
  { icon: Share2, title: 'Smart routing & assignment', body: 'Conversations land with the right person automatically, with assignment, statuses, tags and collision-free collaboration.' },
  { icon: ShieldCheck, title: 'Granular role-based access', body: 'An admin console controls who can see which sections, channels, AI features and actions — per role and per user, enforced down to the database.' },
  { icon: KeyRound, title: 'Bring your own credentials', body: 'Connect each tenant’s own email, WhatsApp, Twilio, Telegram and Meta accounts — encrypted, test-gated, with platform defaults as a fallback.' },
  { icon: Gauge, title: 'SLA & CSAT tracking', body: 'See response times, keep promises with SLA timers, and measure happiness with built-in CSAT surveys.' },
  { icon: BookOpen, title: 'Knowledge base & templates', body: 'Reusable reply templates and a shared knowledge base keep answers fast, on-brand and consistent.' },
  { icon: Building2, title: 'Multi-tenant by design', body: 'Run many brands or clients from one platform. Every tenant is isolated at the database level — data never crosses.' },
]

/**
 * Interactive feature showcase — replaces the old 3×3 grid of identical boxes.
 * Left: a clickable/hoverable list of features. Right (desktop): a live preview
 * panel that animates to the active feature. It gently auto-advances on load to
 * demo every feature, then hands control to the user on first interaction.
 * Mobile: the list shows each body inline (no preview column). Reduced-motion:
 * no auto-advance, and the global rule neutralises the transition.
 */
export function FeaturesShowcase() {
  const [active, setActive] = useState(0)
  const [userTook, setUserTook] = useState(false)

  useEffect(() => {
    if (userTook) return
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const id = window.setInterval(() => setActive((a) => (a + 1) % FEATURES.length), 3500)
    return () => window.clearInterval(id)
  }, [userTook])

  const select = (i: number) => {
    setUserTook(true)
    setActive(i)
  }

  const ActiveIcon = FEATURES[active].icon

  return (
    <div className="mt-14 grid gap-8 lg:grid-cols-2 lg:gap-12">
      {/* Feature list */}
      <ul className="flex flex-col gap-1.5">
        {FEATURES.map((f, i) => {
          const Icon = f.icon
          const on = i === active
          return (
            <li key={f.title}>
              <button
                type="button"
                onMouseEnter={() => select(i)}
                onFocus={() => select(i)}
                onClick={() => select(i)}
                aria-pressed={on}
                className={cn(
                  'group flex w-full items-start gap-4 rounded-xl border p-4 text-left transition-all duration-300',
                  on
                    ? 'border-[var(--brand-accent)]/30 bg-[var(--brand-accent)]/5 shadow-sm'
                    : 'border-transparent hover:border-zinc-200 hover:bg-white'
                )}
              >
                <span
                  className={cn(
                    'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ring-1 transition-colors',
                    on ? 'bg-[var(--brand-accent)] text-white ring-transparent' : 'bg-teal-50 text-teal-700 ring-teal-100'
                  )}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block font-semibold transition-colors', on ? 'text-foreground' : 'text-zinc-700')}>
                    {f.title}
                  </span>
                  {/* body inline on mobile only (no preview column there) */}
                  <span className="mt-1 block text-sm leading-relaxed text-muted-foreground lg:hidden">{f.body}</span>
                </span>
                <ArrowRight
                  className={cn(
                    'hidden h-4 w-4 flex-shrink-0 self-center transition-all duration-300 lg:block',
                    on ? 'translate-x-0 text-[var(--brand-accent)] opacity-100' : '-translate-x-1 opacity-0'
                  )}
                />
              </button>
            </li>
          )
        })}
      </ul>

      {/* Live preview — desktop only */}
      <div className="hidden lg:block">
        <div className="sticky top-28 overflow-hidden rounded-2xl border border-zinc-200 bg-white p-8 shadow-lg shadow-teal-900/5">
          <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-[radial-gradient(circle,rgba(20,184,166,0.18),transparent_70%)] blur-2xl" />
          <div key={active} className="animate-fade-in relative">
            <span className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500 to-emerald-600 text-white shadow-lg shadow-teal-600/25">
              <ActiveIcon className="h-8 w-8" />
            </span>
            <h3 className="mt-6 text-2xl font-bold text-foreground">{FEATURES[active].title}</h3>
            <p className="mt-3 text-base leading-relaxed text-zinc-600">{FEATURES[active].body}</p>
          </div>
          {/* progress indicator */}
          <div className="relative mt-8 flex gap-1.5">
            {FEATURES.map((f, i) => (
              <span
                key={f.title}
                className={cn('h-1.5 rounded-full transition-all duration-300', i === active ? 'w-6 bg-[var(--brand-accent)]' : 'w-1.5 bg-zinc-200')}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
