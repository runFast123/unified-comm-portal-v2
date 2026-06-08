import type { Metadata } from 'next'
import Link from 'next/link'
import { Check, ArrowRight, Sparkles } from 'lucide-react'
import { PageHeader } from '@/components/marketing/page-header'
import { Reveal } from '@/components/marketing/reveal'

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Unified Communication Portal pricing is tailored to your team size and channels. Explore Starter, Growth and Enterprise plans — request a demo for a quote.',
  alternates: { canonical: '/pricing' },
}

const TIERS = [
  {
    name: 'Starter',
    tagline: 'For small teams getting organised.',
    highlight: false,
    features: [
      'Unified inbox — Email, WhatsApp & website live chat',
      'Up to 5 agents',
      'Statuses, tags & assignment',
      'Reply templates',
      'Email & in-app notifications',
    ],
  },
  {
    name: 'Growth',
    tagline: 'For scaling support operations.',
    highlight: true,
    features: [
      'Everything in Starter',
      'All 8 channels — incl. Teams, SMS, Telegram & social',
      'AI-drafted replies (approval-gated)',
      'SLA tracking & CSAT surveys',
      'Knowledge base & macros',
      'Role-based access control',
    ],
  },
  {
    name: 'Enterprise',
    tagline: 'For BPOs & multi-brand operations.',
    highlight: false,
    features: [
      'Everything in Growth',
      'Multi-tenant: unlimited brands',
      'Tenant & channel-level data isolation (RLS)',
      'Bring-your-own-credentials + per-role AI models',
      'Super-admin controls & audit trail',
      'Priority onboarding & support',
    ],
  },
]

export default function PricingPage() {
  return (
    <>
      <PageHeader
        eyebrow="Pricing"
        title="Pricing that fits your team"
        subtitle="Unified is invite-only and priced to your channels, seats and brands. Pick the plan that matches where you are — we’ll tailor a quote in your demo."
      />

      <section className="bg-white py-20 sm:py-24" aria-label="Plans">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-stretch gap-6 lg:grid-cols-3">
            {TIERS.map((t, i) => (
              <Reveal key={t.name} delay={i * 100} className="h-full">
                <div
                  className={`relative flex h-full flex-col rounded-2xl border p-8 shadow-sm transition-all duration-300 hover:-translate-y-1 ${
                    t.highlight
                      ? 'border-teal-300 bg-gradient-to-b from-teal-50/60 to-white shadow-xl shadow-teal-900/10 ring-1 ring-teal-200'
                      : 'border-gray-200 bg-white hover:border-teal-200 hover:shadow-lg'
                  }`}
                >
                  {t.highlight && (
                    <span className="absolute -top-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-gradient-to-r from-teal-700 to-teal-600 px-3.5 py-1 text-xs font-semibold text-white shadow-md">
                      <Sparkles className="h-3.5 w-3.5" /> Most popular
                    </span>
                  )}
                  <h2 className="text-lg font-bold text-gray-900">{t.name}</h2>
                  <p className="mt-1 text-sm text-gray-500">{t.tagline}</p>
                  <div className="mt-6">
                    <span className="text-4xl font-extrabold tracking-tight text-gray-900">Custom</span>
                    <p className="mt-1 text-sm text-gray-500">Tailored to seats &amp; channels</p>
                  </div>
                  <Link
                    href="/contact"
                    className={`mt-6 inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-all ${
                      t.highlight
                        ? 'bg-gradient-to-r from-teal-700 to-teal-600 text-white shadow-lg shadow-teal-700/25 hover:shadow-xl'
                        : 'border border-gray-300 bg-white text-gray-800 hover:border-teal-300 hover:bg-teal-50/50 hover:text-teal-700'
                    }`}
                  >
                    Request a demo
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <ul className="mt-8 space-y-3 border-t border-gray-100 pt-6">
                    {t.features.map((f) => (
                      <li key={f} className="flex items-start gap-2.5 text-sm text-gray-700">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal>
            <p className="mx-auto mt-12 max-w-2xl text-center text-sm text-gray-500">
              All plans include onboarding, true multi-tenant data isolation and the AI assistant
              with human approval. Need something specific? We’ll build a plan around it.
            </p>
          </Reveal>
        </div>
      </section>

      {/* FAQ-ish strip */}
      <section className="bg-gray-50/70 py-16">
        <div className="mx-auto grid max-w-5xl gap-8 px-4 sm:grid-cols-3 sm:px-6 lg:px-8">
          {[
            { q: 'Is there a free trial?', a: 'We run a guided pilot with your real channels during onboarding so you can evaluate Unified on live conversations.' },
            { q: 'How is it billed?', a: 'Pricing scales with agents, channels and brands. We agree a plan during your demo — no surprises.' },
            { q: 'Can we switch plans?', a: 'Yes. Move between Starter, Growth and Enterprise as your team and channel mix change.' },
          ].map((f) => (
            <Reveal key={f.q}>
              <h3 className="text-base font-semibold text-gray-900">{f.q}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">{f.a}</p>
            </Reveal>
          ))}
        </div>
      </section>
    </>
  )
}
