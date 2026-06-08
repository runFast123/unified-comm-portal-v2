import type { Metadata } from 'next'
import Link from 'next/link'
import {
  ArrowRight,
  Inbox,
  Sparkles,
  Share2,
  Gauge,
  BookOpen,
  Building2,
  Mail,
  MessageSquare,
  MessagesSquare,
  ShieldCheck,
  Users,
  Zap,
  Check,
  CheckCircle2,
  Lock,
  BarChart3,
  Bot,
  Workflow,
  Plug,
  Send,
  Facebook,
  Instagram,
  Smartphone,
  KeyRound,
} from 'lucide-react'
import { Reveal } from '@/components/marketing/reveal'
import { CountUp } from '@/components/marketing/count-up'
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from '@/lib/site'

export const metadata: Metadata = {
  description: SITE_DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: { url: SITE_URL, title: `${SITE_NAME} — One AI inbox for every channel` },
}

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

const FEATURES = [
  {
    icon: Inbox,
    title: 'One shared inbox, 8 channels',
    body: 'Email, Teams, WhatsApp, SMS, Telegram, Messenger, Instagram and website live chat — in a single threaded workspace. No more tab-hopping.',
  },
  {
    icon: Sparkles,
    title: 'AI-drafted replies',
    body: 'The assistant writes a context-aware reply in seconds. Your agent reviews and approves — AI never sends on its own.',
  },
  {
    icon: MessagesSquare,
    title: 'Website live chat',
    body: 'Drop a chat bubble on any site with one line of code. Visitor chats land in the same inbox; your replies stream back in real time.',
  },
  {
    icon: Share2,
    title: 'Smart routing & assignment',
    body: 'Conversations land with the right person automatically, with assignment, statuses, tags and collision-free collaboration.',
  },
  {
    icon: ShieldCheck,
    title: 'Granular role-based access',
    body: 'An admin console controls who can see which sections, channels, AI features and actions — per role and per user, enforced down to the database.',
  },
  {
    icon: KeyRound,
    title: 'Bring your own credentials',
    body: 'Connect each tenant’s own email, WhatsApp, Twilio, Telegram and Meta accounts — encrypted, test-gated, with platform defaults as a fallback.',
  },
  {
    icon: Gauge,
    title: 'SLA & CSAT tracking',
    body: 'See response times, keep promises with SLA timers, and measure happiness with built-in CSAT surveys.',
  },
  {
    icon: BookOpen,
    title: 'Knowledge base & templates',
    body: 'Reusable reply templates and a shared knowledge base keep answers fast, on-brand and consistent.',
  },
  {
    icon: Building2,
    title: 'Multi-tenant by design',
    body: 'Run many brands or clients from one platform. Every tenant is isolated at the database level — data never crosses.',
  },
]

const STEPS = [
  {
    icon: Plug,
    title: 'Connect your channels',
    body: 'Plug in email, chat, SMS and social — or drop the live-chat widget on your site. Messages flow into one place, threaded and de-duplicated.',
  },
  {
    icon: Users,
    title: 'Collaborate in one inbox',
    body: 'Assign, tag, set statuses and reply together. Everyone sees the full history; nothing slips through the cracks.',
  },
  {
    icon: Zap,
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

function ChannelBadge({ name }: { name: string }) {
  const map: Record<string, { cls: string; Icon: typeof Mail }> = {
    Email: { cls: 'bg-[#ea4335]', Icon: Mail },
    Teams: { cls: 'bg-[#6264a7]', Icon: MessagesSquare },
    WhatsApp: { cls: 'bg-[#25d366]', Icon: MessageSquare },
    SMS: { cls: 'bg-[#ec4899]', Icon: Smartphone },
    Telegram: { cls: 'bg-[#0088cc]', Icon: Send },
    Messenger: { cls: 'bg-[#0084ff]', Icon: Facebook },
    Instagram: { cls: 'bg-[#e4405f]', Icon: Instagram },
    'Live Chat': { cls: 'bg-[#16a34a]', Icon: MessagesSquare },
  }
  const { cls, Icon } = map[name]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold text-white ${cls}`}>
      <Icon className="h-3.5 w-3.5" />
      {name}
    </span>
  )
}

export default function LandingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([softwareJsonLd, faqJsonLd]) }}
      />

      {/* ───────────────────────── HERO ───────────────────────── */}
      <section className="relative overflow-hidden bg-white" aria-labelledby="hero-heading">
        {/* animated background */}
        <div className="pointer-events-none absolute inset-0 -z-10 bg-dot-grid opacity-70" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
          <div className="animate-blob absolute -left-24 -top-24 h-96 w-96 rounded-full bg-teal-300/40 blur-3xl" />
          <div className="animate-blob absolute right-0 top-10 h-80 w-80 rounded-full bg-emerald-300/40 blur-3xl [animation-delay:3s]" />
          <div className="animate-blob absolute bottom-0 left-1/3 h-80 w-80 rounded-full bg-cyan-200/40 blur-3xl [animation-delay:6s]" />
        </div>
        <div className="absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-b from-transparent to-white" aria-hidden="true" />

        <div className="mx-auto max-w-7xl px-4 pb-20 pt-28 sm:px-6 sm:pt-32 lg:px-8 lg:pb-28">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            {/* copy */}
            <div className="animate-rise">
              <span className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50/80 px-3.5 py-1.5 text-xs font-semibold text-teal-700 shadow-sm">
                <Sparkles className="h-3.5 w-3.5" />
                AI-powered · Multi-channel · Multi-tenant
              </span>
              <h1
                id="hero-heading"
                className="mt-6 text-balance text-4xl font-extrabold leading-[1.08] tracking-tight text-gray-900 sm:text-5xl lg:text-6xl"
              >
                Every customer conversation.{' '}
                <span className="text-gradient">One intelligent inbox.</span>
              </h1>
              <p className="mt-6 max-w-xl text-balance text-lg leading-relaxed text-gray-600">
                Unified brings email, Teams, WhatsApp, SMS, Telegram, social DMs and website
                live chat into a single AI-powered workspace — so your team replies faster,
                together, across every brand you run.
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/contact"
                  className="shine group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-teal-700 to-teal-600 px-6 py-3.5 text-base font-semibold text-white shadow-lg shadow-teal-700/25 transition-all hover:shadow-xl hover:shadow-teal-700/30"
                >
                  Request a demo
                  <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                </Link>
                <Link
                  href="/login"
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-6 py-3.5 text-base font-semibold text-gray-800 transition-colors hover:border-teal-300 hover:bg-teal-50/50 hover:text-teal-700"
                >
                  Sign in
                </Link>
              </div>

              <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-gray-500">
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-teal-600" />
                  Invite-only access
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-teal-600" />
                  Built for teams &amp; BPOs
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-teal-600" />
                  AI you approve
                </span>
              </div>
            </div>

            {/* product mockup */}
            <div className="relative animate-rise [animation-delay:150ms]">
              <div className="animate-float-slow rounded-2xl border border-gray-200 bg-white/90 p-3 shadow-2xl shadow-teal-900/10 backdrop-blur">
                <div className="overflow-hidden rounded-xl border border-gray-100">
                  {/* window chrome */}
                  <div className="flex items-center gap-1.5 border-b border-gray-100 bg-gray-50 px-3 py-2.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                    <span className="ml-3 inline-flex items-center gap-1.5 text-xs font-medium text-gray-400">
                      <Inbox className="h-3.5 w-3.5" /> Shared inbox
                    </span>
                  </div>
                  <div className="grid grid-cols-5">
                    {/* conversation list */}
                    <div className="col-span-2 border-r border-gray-100 bg-gray-50/60">
                      {[
                        { n: 'Ava Chen', c: 'Email', t: 'Refund on order #4821', cls: 'border-l-[#ea4335]', active: true },
                        { n: 'Liam Patel', c: 'WhatsApp', t: 'Where is my delivery?', cls: 'border-l-[#25d366]' },
                        { n: 'Website visitor', c: 'Live Chat', t: 'Is this in stock?', cls: 'border-l-[#16a34a]' },
                        { n: 'Ops Team', c: 'Teams', t: 'Escalation: VIP account', cls: 'border-l-[#6264a7]' },
                      ].map((m) => (
                        <div
                          key={m.n}
                          className={`border-l-2 ${m.cls} px-3 py-3 ${m.active ? 'bg-white' : ''}`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-gray-800">{m.n}</span>
                            <span className="text-[10px] font-medium text-gray-400">{m.c}</span>
                          </div>
                          <p className="mt-0.5 truncate text-[11px] text-gray-500">{m.t}</p>
                        </div>
                      ))}
                    </div>
                    {/* conversation pane */}
                    <div className="col-span-3 bg-white p-3.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-gray-800">Ava Chen</span>
                        <ChannelBadge name="Email" />
                      </div>
                      <div className="mt-3 space-y-2">
                        <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-gray-100 px-3 py-2 text-[11px] text-gray-700">
                          Hi — I’d like a refund on order #4821, it arrived damaged.
                        </div>
                        <div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-teal-600 px-3 py-2 text-[11px] text-white">
                          So sorry, Ava! I’ve started your refund — it’ll land in 3–5 days.
                        </div>
                      </div>
                      {/* AI draft chip */}
                      <div className="mt-3 rounded-lg border border-teal-200 bg-teal-50/70 p-2.5">
                        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-teal-700">
                          <Bot className="h-3.5 w-3.5" /> AI draft · review before send
                        </div>
                        <p className="mt-1 text-[11px] leading-snug text-gray-600">
                          Offer a prepaid return label and confirm the refund timeline…
                        </p>
                        <div className="mt-2 flex gap-1.5">
                          <span className="rounded-md bg-teal-600 px-2 py-1 text-[10px] font-semibold text-white">
                            Approve &amp; send
                          </span>
                          <span className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[10px] font-medium text-gray-600">
                            Edit
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              {/* floating channel chips */}
              <div className="animate-float absolute -left-4 top-10 hidden rounded-xl border border-gray-100 bg-white px-3 py-2 shadow-lg sm:block">
                <ChannelBadge name="WhatsApp" />
              </div>
              <div className="animate-float-slow absolute -right-3 bottom-16 hidden rounded-xl border border-gray-100 bg-white px-3 py-2 shadow-lg sm:block">
                <ChannelBadge name="Teams" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ──────────────── CHANNEL MARQUEE ──────────────── */}
      <section className="border-y border-gray-100 bg-gray-50/60 py-6" aria-label="Channels and capabilities">
        <div className="marquee-mask overflow-hidden">
          <div className="animate-marquee flex w-max items-center gap-10 whitespace-nowrap text-sm font-semibold text-gray-400">
            {Array.from({ length: 2 }).flatMap((_, dup) =>
              [
                'Email',
                'Microsoft Teams',
                'WhatsApp',
                'SMS',
                'Telegram',
                'Messenger',
                'Instagram',
                'Website live chat',
                'AI drafted replies',
                'Smart routing',
                'SLA timers',
                'CSAT surveys',
                'Reply templates',
                'Knowledge base',
                'Multi-tenant',
                'Role-based access',
                'Bring your own credentials',
              ].map((item) => (
                <span key={`${dup}-${item}`} className="inline-flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
                  {item}
                </span>
              )),
            )}
          </div>
        </div>
      </section>

      {/* ──────────────── STATS ──────────────── */}
      <section className="bg-white py-16 sm:py-20" aria-label="At a glance">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
            {[
              { to: 8, suffix: '', label: 'Channels in one inbox' },
              { to: 100, suffix: '%', label: 'Tenant data isolation' },
              { to: 24, suffix: '/7', label: 'Automated message sync' },
              { to: 1, suffix: '', label: 'Workspace, every brand' },
            ].map((s, i) => (
              <Reveal key={s.label} delay={i * 80}>
                <div className="rounded-2xl border border-gray-100 bg-gradient-to-b from-gray-50 to-white p-6 text-center shadow-sm">
                  <div className="text-4xl font-extrabold tracking-tight text-teal-700 sm:text-5xl">
                    <CountUp to={s.to} suffix={s.suffix} />
                  </div>
                  <p className="mt-2 text-sm font-medium text-gray-500">{s.label}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ──────────────── FEATURES ──────────────── */}
      <section id="features" className="bg-gray-50/70 py-20 sm:py-28" aria-labelledby="features-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 id="features-heading" className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
              Everything your team needs to{' '}
              <span className="text-gradient">answer faster</span>
            </h2>
            <p className="mt-4 text-lg text-gray-600">
              One workspace replaces the patchwork of inboxes, chat apps and spreadsheets — with
              AI and automation built in.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={(i % 3) * 90}>
                <div className="group h-full rounded-2xl border border-gray-200 bg-white p-7 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-teal-200 hover:shadow-xl hover:shadow-teal-900/5">
                  <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-teal-50 to-emerald-50 text-teal-700 ring-1 ring-teal-100 transition-colors group-hover:from-teal-600 group-hover:to-teal-700 group-hover:text-white">
                    <f.icon className="h-6 w-6" />
                  </div>
                  <h3 className="mt-5 text-lg font-semibold text-gray-900">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-600">{f.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ──────────────── HOW IT WORKS ──────────────── */}
      <section className="bg-white py-20 sm:py-28" aria-labelledby="how-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal className="mx-auto max-w-2xl text-center">
            <span className="text-sm font-semibold uppercase tracking-wider text-teal-600">How it works</span>
            <h2 id="how-heading" className="mt-3 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
              Live in three steps
            </h2>
          </Reveal>

          <div className="relative mt-16">
            {/* connecting line */}
            <div className="absolute left-0 right-0 top-7 hidden h-px bg-gradient-to-r from-transparent via-teal-200 to-transparent lg:block" aria-hidden="true" />
            <div className="grid gap-10 lg:grid-cols-3">
              {STEPS.map((s, i) => (
                <Reveal key={s.title} delay={i * 120} className="relative text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-700 to-teal-600 text-white shadow-lg shadow-teal-700/25 ring-4 ring-white">
                    <s.icon className="h-6 w-6" />
                  </div>
                  <div className="mx-auto mt-4 inline-flex h-6 w-6 items-center justify-center rounded-full bg-teal-50 text-xs font-bold text-teal-700 ring-1 ring-teal-100">
                    {i + 1}
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-gray-900">{s.title}</h3>
                  <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-gray-600">{s.body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ──────────────── AI SPOTLIGHT ──────────────── */}
      <section className="relative overflow-hidden bg-gradient-to-br from-teal-800 via-teal-700 to-emerald-700 py-20 text-white sm:py-28" aria-labelledby="ai-heading">
        <div className="pointer-events-none absolute inset-0 -z-0 opacity-20" aria-hidden="true">
          <div className="animate-blob absolute -left-20 top-0 h-80 w-80 rounded-full bg-white/30 blur-3xl" />
          <div className="animate-blob absolute bottom-0 right-0 h-80 w-80 rounded-full bg-emerald-300/40 blur-3xl [animation-delay:4s]" />
        </div>
        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3.5 py-1.5 text-xs font-semibold text-white ring-1 ring-white/20">
              <Bot className="h-3.5 w-3.5" /> AI assistant
            </span>
            <h2 id="ai-heading" className="mt-5 text-3xl font-bold tracking-tight sm:text-4xl">
              AI that drafts. People who decide.
            </h2>
            <p className="mt-4 max-w-lg text-lg leading-relaxed text-teal-50">
              Generate a thoughtful, on-brand reply in seconds using the full conversation
              context. Your agent reviews, tweaks and approves — nothing reaches a customer
              without a human’s say-so.
            </p>
            <ul className="mt-7 space-y-3">
              {[
                'Context-aware drafts from the whole thread',
                'Tone and template suggestions',
                'Approval-gated — AI never auto-sends',
                'Per-role AI model assignment by admins',
                'Works across all eight channels',
              ].map((t) => (
                <li key={t} className="flex items-start gap-3 text-teal-50">
                  <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
                  <span className="text-sm">{t}</span>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={120}>
            <div className="rounded-2xl border border-white/15 bg-white/10 p-5 shadow-2xl backdrop-blur-md">
              <div className="rounded-xl bg-white p-4 text-gray-800">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-teal-700">
                  <Sparkles className="h-4 w-4" /> Suggested reply
                </div>
                <p className="mt-3 text-sm leading-relaxed text-gray-700">
                  Hi Ava, I’m so sorry your order arrived damaged. I’ve issued a full refund to
                  your original payment method — you’ll see it within 3–5 business days. I’ve also
                  emailed a prepaid return label. Anything else I can help with?
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-teal-700 to-teal-600 px-3 py-1.5 text-xs font-semibold text-white">
                    <Check className="h-3.5 w-3.5" /> Approve &amp; send
                  </span>
                  <span className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600">
                    Edit draft
                  </span>
                  <span className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600">
                    Regenerate
                  </span>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ──────────────── SECURITY / MULTI-TENANT ──────────────── */}
      <section className="bg-white py-20 sm:py-28" aria-labelledby="security-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <Reveal>
              <span className="text-sm font-semibold uppercase tracking-wider text-teal-600">
                Built for many brands
              </span>
              <h2 id="security-heading" className="mt-3 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
                True multi-tenancy, isolation you can trust
              </h2>
              <p className="mt-4 max-w-lg text-lg leading-relaxed text-gray-600">
                Run a dozen brands or client accounts from a single platform. Every tenant’s
                data is separated at the database layer with row-level security, so information
                never leaks between companies — by accident or otherwise.
              </p>
              <div className="mt-8 grid gap-4 sm:grid-cols-2">
                {TRUST.map((t) => (
                  <div key={t.label} className="flex items-center gap-3 rounded-xl border border-gray-100 bg-gray-50/70 p-4">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 ring-1 ring-teal-100">
                      <t.icon className="h-5 w-5" />
                    </span>
                    <span className="text-sm font-medium text-gray-700">{t.label}</span>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal delay={120}>
              <div className="relative rounded-2xl border border-gray-200 bg-gradient-to-br from-gray-50 to-white p-6 shadow-lg">
                <div className="space-y-3">
                  {['Brand A', 'Brand B', 'Brand C'].map((b, i) => (
                    <div
                      key={b}
                      className="flex items-center justify-between rounded-xl border border-gray-100 bg-white p-4 shadow-sm"
                      style={{ marginLeft: `${i * 12}px` }}
                    >
                      <div className="flex items-center gap-3">
                        <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-teal-600 to-teal-700 text-white">
                          <Building2 className="h-5 w-5" />
                        </span>
                        <div>
                          <p className="text-sm font-semibold text-gray-800">{b}</p>
                          <p className="text-[11px] text-gray-400">Isolated workspace</p>
                        </div>
                      </div>
                      <Lock className="h-4 w-4 text-teal-600" />
                    </div>
                  ))}
                </div>
                <p className="mt-5 text-center text-xs font-medium text-gray-400">
                  One platform · separate, secure tenants
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ──────────────── FAQ ──────────────── */}
      <section className="bg-gray-50/70 py-20 sm:py-28" aria-labelledby="faq-heading">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <Reveal className="text-center">
            <h2 id="faq-heading" className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
              Frequently asked questions
            </h2>
          </Reveal>
          <div className="mt-12 space-y-3">
            {FAQ.map((f, i) => (
              <Reveal key={f.q} delay={i * 60}>
                <details className="group rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-colors open:border-teal-200 open:shadow-md">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-semibold text-gray-900">
                    {f.q}
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-700 transition-transform group-open:rotate-45">
                      <span className="text-lg leading-none">+</span>
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-gray-600">{f.a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ──────────────── FINAL CTA ──────────────── */}
      <section className="bg-white py-20 sm:py-24" aria-labelledby="cta-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-teal-800 via-teal-700 to-emerald-700 px-6 py-16 text-center shadow-2xl shadow-teal-900/20 sm:px-16">
              <div className="pointer-events-none absolute inset-0 -z-0 opacity-25" aria-hidden="true">
                <div className="animate-blob absolute -left-10 -top-10 h-72 w-72 rounded-full bg-white/30 blur-3xl" />
                <div className="animate-blob absolute -bottom-10 right-0 h-72 w-72 rounded-full bg-emerald-300/40 blur-3xl [animation-delay:4s]" />
              </div>
              <div className="relative">
                <h2 id="cta-heading" className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
                  Bring every conversation together
                </h2>
                <p className="mx-auto mt-4 max-w-xl text-lg text-teal-50">
                  See Unified in action. We’ll connect your channels, set up your workspace and
                  onboard your team.
                </p>
                <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
                  <Link
                    href="/contact"
                    className="group inline-flex items-center justify-center gap-2 rounded-xl bg-white px-6 py-3.5 text-base font-semibold text-teal-700 shadow-lg transition-all hover:shadow-xl"
                  >
                    Request a demo
                    <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                  </Link>
                  <Link
                    href="/pricing"
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/30 bg-white/10 px-6 py-3.5 text-base font-semibold text-white backdrop-blur transition-colors hover:bg-white/20"
                  >
                    View pricing
                  </Link>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  )
}
