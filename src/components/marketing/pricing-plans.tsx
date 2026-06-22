'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, ArrowRight, Sparkles } from 'lucide-react'
import { Reveal } from './reveal'

const MONO = 'font-[family-name:var(--font-geist-mono)]'

const TIERS = [
  {
    name: 'Starter',
    tagline: 'For small teams getting organised.',
    features: ['Unified inbox — Email, WhatsApp & website live chat', 'Up to 5 agents', 'Statuses, tags & assignment', 'Reply templates', 'Email & in-app notifications'],
  },
  {
    name: 'Growth',
    tagline: 'For scaling support operations.',
    features: ['Everything in Starter', 'All 8 channels — incl. Teams, SMS, Telegram & social', 'AI-drafted replies (approval-gated)', 'SLA tracking & CSAT surveys', 'Knowledge base & macros', 'Role-based access control'],
  },
  {
    name: 'Enterprise',
    tagline: 'For BPOs & multi-brand operations.',
    features: ['Everything in Growth', 'Multi-tenant: unlimited brands', 'Tenant & channel-level data isolation (RLS)', 'Bring-your-own-credentials + per-role AI models', 'Super-admin controls & audit trail', 'Priority onboarding & support'],
  },
]

// Team-size buckets → recommended tier index.
const SIZES = [
  { label: '1–5', rec: 0 },
  { label: '6–20', rec: 1 },
  { label: '21–50', rec: 1 },
  { label: '50+ / multi-brand', rec: 2 },
]

/**
 * Interactive pricing. Since plans are quote-based, the visitor picks their team
 * size and the matching tier is highlighted as "Recommended for you" with a
 * one-line rationale — helping them self-select before the demo. Default (no
 * pick) keeps Growth flagged "Most popular". Light Console theme.
 */
export function PricingPlans() {
  const [pick, setPick] = useState<number | null>(null)
  const recommended = pick === null ? 1 : SIZES[pick].rec

  return (
    <section className="py-20 sm:py-24" aria-label="Plans">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Plan finder */}
        <Reveal className="mx-auto mb-12 max-w-xl text-center">
          <p className={`${MONO} text-[12px] tracking-tight text-teal-700`}>How big is your team?</p>
          <div className="mt-3 inline-flex flex-wrap justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white p-1.5">
            {SIZES.map((s, i) => {
              const on = pick === i
              return (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => setPick(i)}
                  aria-pressed={on}
                  className={`${MONO} rounded-lg px-3.5 py-2 text-[12px] transition-colors ${
                    on ? 'bg-teal-600 text-white' : 'text-zinc-600 hover:bg-zinc-100'
                  }`}
                >
                  {s.label}
                </button>
              )
            })}
          </div>
          <p className="mt-3 h-5 text-sm text-zinc-500">
            {pick !== null && (
              <>For a team of <span className="font-medium text-zinc-800">{SIZES[pick].label}</span>, we’d start you on <span className="font-medium text-teal-700">{TIERS[recommended].name}</span>.</>
            )}
          </p>
        </Reveal>

        <div className="grid items-stretch gap-6 lg:grid-cols-3">
          {TIERS.map((t, i) => {
            const isRec = i === recommended
            return (
              <Reveal key={t.name} delay={i * 100} className="h-full">
                <div
                  className={`relative flex h-full flex-col rounded-2xl border p-8 transition-colors ${
                    isRec ? 'border-teal-500 bg-white' : 'border-zinc-200 bg-white hover:border-zinc-300'
                  }`}
                >
                  {isRec && (
                    <span className="absolute -top-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-teal-50 px-3.5 py-1 font-[family-name:var(--font-geist-mono)] text-[12px] tracking-tight text-teal-700 ring-1 ring-teal-500">
                      <Sparkles className="h-3.5 w-3.5" /> {pick === null ? 'Most popular' : 'Recommended for you'}
                    </span>
                  )}
                  <h2 className="text-lg font-semibold tracking-[-0.02em] text-zinc-900">{t.name}</h2>
                  <p className="mt-1 text-sm text-zinc-500">{t.tagline}</p>
                  <div className="mt-6">
                    <span className={`${MONO} text-4xl font-medium tracking-tight tabular-nums text-zinc-900`}>Custom</span>
                    <p className="mt-1 text-sm text-zinc-500">Tailored to seats &amp; channels</p>
                  </div>
                  <Link
                    href="/contact"
                    className={
                      isRec
                        ? 'group mt-6 inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--brand-accent)] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-teal-800'
                        : 'mt-6 inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-300 px-5 py-3 text-sm font-medium text-zinc-800 transition-colors hover:border-zinc-400 hover:bg-zinc-50'
                    }
                  >
                    Request a demo
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <ul className="mt-8 space-y-3 border-t border-zinc-200 pt-6">
                    {t.features.map((f) => (
                      <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-700">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Reveal>
            )
          })}
        </div>

        <Reveal>
          <p className="mx-auto mt-12 max-w-2xl text-center text-sm text-zinc-500">
            All plans include onboarding, true multi-tenant data isolation and the AI assistant with
            human approval. Need something specific? We’ll build a plan around it.
          </p>
        </Reveal>
      </div>
    </section>
  )
}
