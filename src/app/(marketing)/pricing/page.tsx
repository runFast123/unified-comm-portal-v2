import type { Metadata } from 'next'
import { PageHeader } from '@/components/marketing/page-header'
import { Reveal } from '@/components/marketing/reveal'
import { PricingPlans } from '@/components/marketing/pricing-plans'

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Unified Communication Portal pricing is tailored to your team size and channels. Explore Starter, Growth and Enterprise plans — request a demo for a quote.',
  alternates: { canonical: '/pricing' },
}

export default function PricingPage() {
  return (
    <>
      <PageHeader
        eyebrow="Pricing"
        title="Pricing that fits your team"
        subtitle="Unified is invite-only and priced to your channels, seats and brands. Pick the plan that matches where you are — we’ll tailor a quote in your demo."
      />

      <PricingPlans />

      {/* FAQ-ish strip */}
      <section className="py-16">
        <div className="mx-auto grid max-w-5xl gap-8 px-4 sm:grid-cols-3 sm:px-6 lg:px-8">
          {[
            { q: 'Is there a free trial?', a: 'We run a guided pilot with your real channels during onboarding so you can evaluate Unified on live conversations.' },
            { q: 'How is it billed?', a: 'Pricing scales with agents, channels and brands. We agree a plan during your demo — no surprises.' },
            { q: 'Can we switch plans?', a: 'Yes. Move between Starter, Growth and Enterprise as your team and channel mix change.' },
          ].map((f) => (
            <Reveal key={f.q}>
              <h3 className="text-base font-semibold tracking-[-0.02em] text-zinc-900">{f.q}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">{f.a}</p>
            </Reveal>
          ))}
        </div>
      </section>
    </>
  )
}
