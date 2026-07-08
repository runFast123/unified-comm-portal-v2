import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, Bot, Check, Lock, ShieldCheck, BarChart3, Workflow } from 'lucide-react'
import { Reveal } from '@/components/marketing/reveal'
import { CountUp } from '@/components/marketing/count-up'
import { HeroPanels } from '@/components/marketing/hero-panels'
import { FeaturesBento } from '@/components/marketing/features-bento'
import { RoutingDiagram } from '@/components/marketing/routing-diagram'
import { AiDraftDemo } from '@/components/marketing/ai-draft-demo'
import { TenantSwitcher } from '@/components/marketing/tenant-switcher'
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from '@/lib/site'

export const metadata: Metadata = {
  description: SITE_DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: { url: SITE_URL, title: `${SITE_NAME} — One AI inbox for every channel` },
}

const MONO = 'font-[family-name:var(--font-geist-mono)]'

const FAQ = [
  {
    q: 'Which channels does Unified support?',
    a: 'Eight, in one shared inbox: email, Microsoft Teams, WhatsApp, SMS, Telegram, Facebook Messenger, Instagram DM, and an embeddable website live-chat widget. Every message — wherever it arrives — lands in the same place, threaded and ready for your team.',
  },
  {
    q: 'Does the AI send replies on its own?',
    a: 'No. The AI drafts a reply in seconds and your agent reviews, edits and approves it before anything is sent. You stay in control of every customer-facing message — and admins can choose which AI model each role or user is allowed to use.',
  },
  {
    q: 'Can one workspace run multiple brands or clients?',
    a: 'Yes. Unified is multi-tenant by design. Each company is fully isolated at the database level with row-level security, so a BPO or agency can run many brands side by side without data ever crossing between them.',
  },
  {
    q: 'How do roles and permissions work?',
    a: 'A full role-based access console lets admins decide — per role and per user — exactly which sections, channels, AI features and actions each person can use. Channel visibility is even enforced at the database, so an agent only ever sees the conversations they are cleared for.',
  },
  {
    q: 'Can we use our own provider credentials?',
    a: 'Yes — bring-your-own-credentials is first-class. Each tenant connects its own email, WhatsApp, Twilio, Telegram and Meta accounts behind a test-connection gate, or falls back to the platform defaults. Your keys are encrypted and never leave your tenant.',
  },
  {
    q: 'How do we get started?',
    a: 'Unified is invite-only for now. Request a demo and we will set up your workspace, connect your channels and onboard your team.',
  },
]

const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
}

const softwareJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: SITE_NAME,
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web',
  description: SITE_DESCRIPTION,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
}

const STEPS = [
  {
    n: '01',
    title: 'Connect your channels',
    body: 'Plug in email, chat, SMS and social — or drop the live-chat widget on your site. Messages flow into one place, threaded and de-duplicated.',
  },
  {
    n: '02',
    title: 'Collaborate in one inbox',
    body: 'Assign, tag, set statuses and reply together. Everyone sees the full history; nothing slips through the cracks.',
  },
  {
    n: '03',
    title: 'Resolve faster with AI',
    body: 'Generate a draft, review it, and send. Track SLAs and CSAT so every customer gets a fast, quality answer.',
  },
]

const TRUST = [
  { icon: Lock, label: 'Tenant-level data isolation (RLS)' },
  { icon: ShieldCheck, label: 'Role-based access control' },
  { icon: BarChart3, label: 'Full audit trail & request tracing' },
  { icon: Workflow, label: 'Approval-gated AI sending' },
]

const MARQUEE_ITEMS = [
  'Email', 'Microsoft Teams', 'WhatsApp', 'SMS', 'Telegram', 'Messenger', 'Instagram',
  'Website live chat', 'AI drafted replies', 'Smart routing', 'SLA timers', 'CSAT surveys',
  'Reply templates', 'Knowledge base', 'Multi-tenant', 'Role-based access', 'Bring your own credentials',
]

export default function LandingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([softwareJsonLd, faqJsonLd]) }}
      />

      {/* ───────────────────────── HERO ───────────────────────── */}
      <section className="relative isolate overflow-hidden" aria-labelledby="hero-heading">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-dot-grid opacity-60" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-zinc-200 to-transparent" aria-hidden="true" />

        <div className="mx-auto max-w-7xl px-4 pb-24 pt-32 sm:px-6 sm:pt-36 lg:px-8 lg:pb-28">
          <div className="grid items-center gap-16 lg:grid-cols-2">
            <div className="animate-rise">
              <span className={`${MONO} inline-flex items-center gap-2 text-[12px] tracking-tight text-zinc-600`}>
                <span className="h-1.5 w-1.5 rounded-full bg-teal-600" />
                Support operations platform
              </span>
              <h1
                id="hero-heading"
                className="mt-6 text-balance text-5xl font-semibold leading-[1.02] tracking-[-0.03em] text-zinc-900 sm:text-6xl"
              >
                Eight channels.<br />One inbox.
              </h1>
              <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-zinc-600">
                Every customer conversation — email, WhatsApp, Teams, SMS, Telegram, social DMs and
                website live chat — in a single AI-assisted queue your whole team works from.
              </p>

              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/contact"
                  className="group inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--brand-accent)] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-teal-800"
                >
                  Request a demo
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
                <Link
                  href="/login"
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-300 px-5 py-3 text-sm font-medium text-zinc-800 transition-colors hover:border-zinc-300 hover:bg-zinc-50"
                >
                  Sign in
                </Link>
              </div>

              <div className={`${MONO} mt-9 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-zinc-500`}>
                <span>8 channels</span>
                <span className="text-zinc-300">·</span>
                <span>approval-gated AI</span>
                <span className="text-zinc-300">·</span>
                <span>multi-tenant by design</span>
              </div>
            </div>

            <div className="animate-rise [animation-delay:120ms]">
              <HeroPanels />
            </div>
          </div>
        </div>
      </section>

      {/* ──────────────── CHANNEL MARQUEE ──────────────── */}
      <section className="border-y border-zinc-200 py-5" aria-label="Channels and capabilities">
        <div className="marquee-mask overflow-hidden" aria-hidden="true">
          <div className={`${MONO} animate-marquee flex w-max items-center gap-8 whitespace-nowrap text-[13px] text-zinc-500`}>
            {Array.from({ length: 2 }).flatMap((_, dup) =>
              MARQUEE_ITEMS.map((item) => (
                <span key={`${dup}-${item}`} className="inline-flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-teal-500" />
                  {item}
                </span>
              )),
            )}
          </div>
        </div>
      </section>

      {/* ──────────────── STATS ──────────────── */}
      <section className="py-16 sm:py-20" aria-label="At a glance">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 lg:grid-cols-4">
            {[
              { to: 8, suffix: '', label: 'Channels in one inbox' },
              { to: 100, suffix: '%', label: 'Tenant data isolation' },
              { to: 24, suffix: '/7', label: 'Automated message sync' },
              { to: 1, suffix: '', label: 'Workspace, every brand' },
            ].map((s, i) => (
              <Reveal key={s.label} delay={i * 80}>
                <div className="h-full bg-white p-6">
                  <div className={`${MONO} text-4xl font-medium tabular-nums tracking-tight text-zinc-900 sm:text-5xl`}>
                    <CountUp to={s.to} />
                    <span className="text-teal-700">{s.suffix}</span>
                  </div>
                  <p className="mt-2 text-sm text-zinc-500">{s.label}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ──────────────── FEATURES ──────────────── */}
      <section id="features" className="py-20 sm:py-28" aria-labelledby="features-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal className="max-w-2xl">
            <span className={`${MONO} text-[12px] tracking-tight text-teal-700`}>Capabilities</span>
            <h2 id="features-heading" className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-zinc-900 sm:text-4xl">
              Everything your team needs to answer faster
            </h2>
            <p className="mt-4 text-lg text-zinc-600">
              One workspace replaces the patchwork of inboxes, chat apps and spreadsheets — with AI
              and automation built in.
            </p>
          </Reveal>

          <FeaturesBento />
        </div>
      </section>

      {/* ──────────────── HOW IT WORKS / ROUTING ──────────────── */}
      <section className="py-20 sm:py-28" aria-labelledby="how-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal className="max-w-2xl">
            <span className={`${MONO} text-[12px] tracking-tight text-teal-700`}>How it works</span>
            <h2 id="how-heading" className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-zinc-900 sm:text-4xl">
              Many channels in. One thread out.
            </h2>
          </Reveal>

          <Reveal className="mt-12">
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 sm:p-10">
              <RoutingDiagram />
            </div>
          </Reveal>

          <div className="mt-12 grid gap-8 sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <Reveal key={s.title} delay={i * 100}>
                <div className="border-t border-zinc-200 pt-5">
                  <span className={`${MONO} text-[12px] tabular-nums text-teal-700`}>{s.n}</span>
                  <h3 className="mt-2 text-base font-medium text-zinc-900">{s.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ──────────────── AI SPOTLIGHT ──────────────── */}
      <section className="border-y border-zinc-200 bg-zinc-50 py-20 sm:py-28" aria-labelledby="ai-heading">
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
          <Reveal>
            <span className={`${MONO} inline-flex items-center gap-2 text-[12px] tracking-tight text-teal-700`}>
              <Bot className="h-3.5 w-3.5" /> AI assistant
            </span>
            <h2 id="ai-heading" className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-zinc-900 sm:text-4xl">
              AI that drafts. People who decide.
            </h2>
            <p className="mt-4 max-w-lg text-lg leading-relaxed text-zinc-600">
              Generate a thoughtful, on-brand reply in seconds using the full conversation context.
              Your agent reviews, tweaks and approves — nothing reaches a customer without a human’s
              say-so.
            </p>
            <ul className="mt-7 space-y-3">
              {[
                'Context-aware drafts from the whole thread',
                'Tone and template suggestions',
                'Approval-gated — AI never auto-sends',
                'Per-role AI model assignment by admins',
                'Works across all eight channels',
              ].map((t) => (
                <li key={t} className="flex items-start gap-3 text-zinc-700">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                  <span className="text-sm">{t}</span>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={120}>
            <AiDraftDemo />
          </Reveal>
        </div>
      </section>

      {/* ──────────────── SECURITY / MULTI-TENANT ──────────────── */}
      <section className="py-20 sm:py-28" aria-labelledby="security-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-center gap-14 lg:grid-cols-2">
            <Reveal>
              <span className={`${MONO} text-[12px] tracking-tight text-teal-700`}>Built for many brands</span>
              <h2 id="security-heading" className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-zinc-900 sm:text-4xl">
                True multi-tenancy, isolation you can trust
              </h2>
              <p className="mt-4 max-w-lg text-lg leading-relaxed text-zinc-600">
                Run a dozen brands or client accounts from a single platform. Every tenant’s data is
                separated at the database layer with row-level security, so information never leaks
                between companies — by accident or otherwise.
              </p>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                {TRUST.map((t) => (
                  <div key={t.label} className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-4">
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-teal-700 ring-1 ring-zinc-200">
                      <t.icon className="h-4 w-4" />
                    </span>
                    <span className="text-sm text-zinc-700">{t.label}</span>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal delay={120}>
              <TenantSwitcher />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ──────────────── FAQ ──────────────── */}
      <section className="py-20 sm:py-28" aria-labelledby="faq-heading">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <h2 id="faq-heading" className="text-3xl font-semibold tracking-[-0.02em] text-zinc-900 sm:text-4xl">
              Frequently asked questions
            </h2>
          </Reveal>
          <div className="mt-10 space-y-2.5">
            {FAQ.map((f, i) => (
              <Reveal key={f.q} delay={i * 50}>
                <details className="group rounded-xl border border-zinc-200 bg-white p-5 transition-colors open:border-zinc-300">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-medium text-zinc-900">
                    {f.q}
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-200 text-zinc-600 transition-transform group-open:rotate-45">
                      <span className="text-lg leading-none">+</span>
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-zinc-600">{f.a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ──────────────── FINAL CTA ──────────────── */}
      <section className="py-20 sm:py-24" aria-labelledby="cta-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="relative isolate overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 px-6 py-16 text-center sm:px-16">
              <div className="pointer-events-none absolute inset-0 -z-10 bg-dot-grid opacity-40" aria-hidden="true" />
              <h2 id="cta-heading" className="text-3xl font-semibold tracking-[-0.02em] text-zinc-900 sm:text-4xl">
                Bring every conversation together
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-lg text-zinc-600">
                See Unified in action. We’ll connect your channels, set up your workspace and onboard
                your team.
              </p>
              <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
                <Link
                  href="/contact"
                  className="group inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--brand-accent)] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-teal-800"
                >
                  Request a demo
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
                <Link
                  href="/pricing"
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-300 px-5 py-3 text-sm font-medium text-zinc-800 transition-colors hover:border-zinc-300 hover:bg-zinc-50"
                >
                  View pricing
                </Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  )
}
