import type { Metadata } from 'next'
import Link from 'next/link'
import { Mail, MessageSquareText, LogIn, Clock, ShieldCheck } from 'lucide-react'
import { PageHeader } from '@/components/marketing/page-header'
import { Reveal } from '@/components/marketing/reveal'
import { ContactForm } from '@/components/marketing/contact-form'
import { CONTACT_EMAIL } from '@/lib/site'

export const metadata: Metadata = {
  title: 'Contact',
  description:
    'Request a demo of Unified Communication Portal. Tell us about your channels and team and we’ll set up your workspace and onboard you.',
  alternates: { canonical: '/contact' },
}

export default function ContactPage() {
  return (
    <>
      <PageHeader
        eyebrow="Contact"
        title="Let’s get you set up"
        subtitle="Tell us a little about your team and we’ll show you Unified connected to a live inbox — then help you onboard."
      />

      <section className="py-16 sm:py-20" aria-label="Contact form">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-12 lg:grid-cols-5">
            {/* form */}
            <Reveal className="lg:col-span-3">
              <div className="rounded-2xl border border-zinc-200 bg-white p-7 transition-colors hover:border-zinc-300 sm:p-9">
                <h2 className="text-xl font-semibold tracking-[-0.02em] text-zinc-900">Request a demo</h2>
                <p className="mt-1.5 text-sm text-zinc-500">
                  We usually reply within one business day.
                </p>
                <div className="mt-6">
                  <ContactForm contactEmail={CONTACT_EMAIL} />
                </div>
              </div>
            </Reveal>

            {/* side info */}
            <div className="space-y-4 lg:col-span-2">
              <Reveal delay={80}>
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="flex items-start gap-4 rounded-2xl border border-zinc-200 bg-white p-6 transition-colors hover:border-zinc-300"
                >
                  <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 ring-1 ring-teal-100">
                    <Mail className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="text-base font-semibold tracking-[-0.02em] text-zinc-900">Email us</h3>
                    <p className="mt-1 text-sm text-zinc-600 font-[family-name:var(--font-geist-mono)] tabular-nums">{CONTACT_EMAIL}</p>
                  </div>
                </a>
              </Reveal>

              <Reveal delay={160}>
                <Link
                  href="/login"
                  className="flex items-start gap-4 rounded-2xl border border-zinc-200 bg-white p-6 transition-colors hover:border-zinc-300"
                >
                  <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 ring-1 ring-teal-100">
                    <LogIn className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="text-base font-semibold tracking-[-0.02em] text-zinc-900">Already a customer?</h3>
                    <p className="mt-1 text-sm text-zinc-600">Sign in to your workspace.</p>
                  </div>
                </Link>
              </Reveal>

              <Reveal delay={240}>
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6">
                  <h3 className="flex items-center gap-2 text-base font-semibold tracking-[-0.02em] text-zinc-900">
                    <MessageSquareText className="h-5 w-5 text-teal-700" /> What to expect
                  </h3>
                  <ul className="mt-4 space-y-3 text-sm text-zinc-600">
                    <li className="flex items-start gap-2.5">
                      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                      A quick reply to schedule a walkthrough.
                    </li>
                    <li className="flex items-start gap-2.5">
                      <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                      A demo on your channels, not a generic deck.
                    </li>
                    <li className="flex items-start gap-2.5">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                      Guided onboarding with your data kept isolated.
                    </li>
                  </ul>
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
