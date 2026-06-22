import type { Metadata } from 'next'
import Link from 'next/link'
import { Target, Heart, ShieldCheck, Zap, Layers, Users, ArrowRight } from 'lucide-react'
import { PageHeader } from '@/components/marketing/page-header'
import { Reveal } from '@/components/marketing/reveal'

export const metadata: Metadata = {
  title: 'About',
  description:
    'Unified Communication Portal is on a mission to bring every customer conversation — email, Teams, WhatsApp, SMS, Telegram, Messenger, Instagram and website live chat — into one AI-powered, multi-tenant workspace for teams and BPOs.',
  alternates: { canonical: '/about' },
}

const VALUES = [
  { icon: Layers, title: 'One place, not ten', body: 'Customers shouldn’t fall through the cracks between tools. We unify the channels so teams can focus on people, not tabs.' },
  { icon: ShieldCheck, title: 'Trust by design', body: 'Multi-tenant isolation, role-based access and audit trails aren’t add-ons — they’re the foundation.' },
  { icon: Zap, title: 'AI that assists', body: 'We use AI to remove busywork, never to remove judgement. A human approves every customer reply.' },
  { icon: Heart, title: 'Built for service', body: 'Great support is a craft. Our job is to give the people who do it the fastest, calmest workspace possible.' },
]

export default function AboutPage() {
  return (
    <>
      <PageHeader
        eyebrow="About"
        title="We bring every conversation together"
        subtitle="Support teams juggle too many inboxes, apps and spreadsheets. Unified exists to put every channel — email, chat, SMS, social and website live chat — and the AI to handle them, in one trustworthy place."
      />

      {/* Mission */}
      <section className="py-20 sm:py-24" aria-label="Our mission">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <Reveal>
              <span className="inline-flex items-center gap-2 font-[family-name:var(--font-geist-mono)] text-[12px] tracking-tight text-teal-400">
                <Target className="h-4 w-4" /> Our mission
              </span>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-zinc-50 sm:text-4xl">
                Make exceptional support effortless to deliver
              </h2>
              <div className="mt-5 space-y-4 text-lg leading-relaxed text-zinc-400">
                <p>
                  Every day, teams lose time switching between an email client, a chat app and a
                  messaging tool — copying context, missing replies and guessing at who said what.
                </p>
                <p>
                  Unified collapses that chaos into a single shared inbox. Add an AI assistant that
                  drafts replies, smart routing that gets the right person involved, and true
                  multi-tenancy that lets one team run many brands — and suddenly support feels calm,
                  fast and in control.
                </p>
              </div>
            </Reveal>

            <Reveal delay={120}>
              <div className="grid grid-cols-2 gap-4">
                {[
                  { k: '8', v: 'Channels, one inbox' },
                  { k: '100%', v: 'Tenant isolation' },
                  { k: 'AI', v: 'Drafts, you approve' },
                  { k: '1', v: 'Platform, many brands' },
                ].map((s) => (
                  <div key={s.v} className="rounded-2xl border border-white/10 bg-[#141416] p-6 text-center transition-colors hover:border-white/20">
                    <div className="text-3xl font-medium font-[family-name:var(--font-geist-mono)] tabular-nums text-teal-300">{s.k}</div>
                    <p className="mt-1 text-sm font-medium text-zinc-500">{s.v}</p>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="py-20 sm:py-24" aria-labelledby="values-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 id="values-heading" className="text-3xl font-semibold tracking-[-0.02em] text-zinc-50 sm:text-4xl">
              What we believe
            </h2>
          </Reveal>
          <div className="mt-14 grid gap-6 sm:grid-cols-2">
            {VALUES.map((v, i) => (
              <Reveal key={v.title} delay={(i % 2) * 100}>
                <div className="flex h-full gap-5 rounded-2xl border border-white/10 bg-[#141416] p-7 transition-colors hover:border-white/20">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-teal-300 ring-1 ring-white/10">
                    <v.icon className="h-6 w-6" />
                  </span>
                  <div>
                    <h3 className="text-lg font-semibold text-zinc-50">{v.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-400">{v.body}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Who it's for */}
      <section className="py-20 sm:py-24" aria-labelledby="who-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal className="mx-auto max-w-2xl text-center">
            <span className="inline-flex items-center gap-2 font-[family-name:var(--font-geist-mono)] text-[12px] tracking-tight text-teal-400">
              <Users className="h-4 w-4" /> Who it’s for
            </span>
            <h2 id="who-heading" className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-zinc-50 sm:text-4xl">
              Made for the people on the front line
            </h2>
          </Reveal>
          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            {[
              { t: 'In-house support teams', b: 'Consolidate channels and reply faster without losing the personal touch.' },
              { t: 'BPOs & agencies', b: 'Run many client brands from one platform, each fully isolated and on-brand.' },
              { t: 'Multi-brand operations', b: 'Keep separate inboxes for every brand while your team works in one place.' },
            ].map((c) => (
              <Reveal key={c.t}>
                <div className="h-full rounded-2xl border border-white/10 bg-[#141416] p-7 transition-colors hover:border-white/20">
                  <h3 className="text-base font-semibold text-zinc-50">{c.t}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-400">{c.b}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <Reveal>
            <h2 className="text-3xl font-semibold tracking-[-0.02em] text-zinc-50 sm:text-4xl">
              Let’s bring your conversations together
            </h2>
            <div className="mt-8">
              <Link
                href="/contact"
                className="group inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--brand-accent)] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-teal-600"
              >
                Request a demo
                <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  )
}
