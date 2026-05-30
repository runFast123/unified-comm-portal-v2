import type { Metadata } from 'next'
import Link from 'next/link'
import { Target, Heart, ShieldCheck, Zap, Layers, Users, ArrowRight } from 'lucide-react'
import { PageHeader } from '@/components/marketing/page-header'
import { Reveal } from '@/components/marketing/reveal'

export const metadata: Metadata = {
  title: 'About',
  description:
    'Unified Communication Portal is on a mission to bring every customer conversation — email, Teams and WhatsApp — into one AI-powered, multi-tenant workspace for teams and BPOs.',
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
        subtitle="Support teams juggle too many inboxes, apps and spreadsheets. Unified exists to put email, Teams and WhatsApp — and the AI to handle them — in one trustworthy place."
      />

      {/* Mission */}
      <section className="bg-white py-20 sm:py-24" aria-label="Our mission">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <Reveal>
              <span className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-teal-600">
                <Target className="h-4 w-4" /> Our mission
              </span>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
                Make exceptional support effortless to deliver
              </h2>
              <div className="mt-5 space-y-4 text-lg leading-relaxed text-gray-600">
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
                  { k: '3', v: 'Channels, one inbox' },
                  { k: '100%', v: 'Tenant isolation' },
                  { k: 'AI', v: 'Drafts, you approve' },
                  { k: '1', v: 'Platform, many brands' },
                ].map((s) => (
                  <div key={s.v} className="rounded-2xl border border-gray-100 bg-gradient-to-b from-gray-50 to-white p-6 text-center shadow-sm">
                    <div className="text-3xl font-extrabold text-teal-700">{s.k}</div>
                    <p className="mt-1 text-sm font-medium text-gray-500">{s.v}</p>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="bg-gray-50/70 py-20 sm:py-24" aria-labelledby="values-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 id="values-heading" className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
              What we believe
            </h2>
          </Reveal>
          <div className="mt-14 grid gap-6 sm:grid-cols-2">
            {VALUES.map((v, i) => (
              <Reveal key={v.title} delay={(i % 2) * 100}>
                <div className="flex h-full gap-5 rounded-2xl border border-gray-200 bg-white p-7 shadow-sm transition-all hover:border-teal-200 hover:shadow-lg">
                  <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-600 to-teal-700 text-white shadow-md shadow-teal-700/20">
                    <v.icon className="h-6 w-6" />
                  </span>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{v.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">{v.body}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Who it's for */}
      <section className="bg-white py-20 sm:py-24" aria-labelledby="who-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal className="mx-auto max-w-2xl text-center">
            <span className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-teal-600">
              <Users className="h-4 w-4" /> Who it’s for
            </span>
            <h2 id="who-heading" className="mt-3 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
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
                <div className="h-full rounded-2xl border border-gray-200 bg-gradient-to-b from-gray-50 to-white p-7 shadow-sm">
                  <h3 className="text-base font-semibold text-gray-900">{c.t}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-600">{c.b}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-gray-50/70 py-20">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <Reveal>
            <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
              Let’s bring your conversations together
            </h2>
            <div className="mt-8">
              <Link
                href="/contact"
                className="group inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-teal-700 to-teal-600 px-6 py-3.5 text-base font-semibold text-white shadow-lg shadow-teal-700/25 transition-all hover:shadow-xl"
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
