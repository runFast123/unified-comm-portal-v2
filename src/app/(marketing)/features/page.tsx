import type { Metadata } from 'next'
import Link from 'next/link'
import {
  Sparkles,
  Share2,
  Gauge,
  BookOpen,
  Building2,
  Mail,
  MessageSquare,
  MessagesSquare,
  ShieldCheck,
  Tag,
  ClipboardList,
  Bot,
  ArrowRight,
  Check,
  Smartphone,
  Send,
  Facebook,
  Instagram,
  KeyRound,
  Cpu,
} from 'lucide-react'
import { PageHeader } from '@/components/marketing/page-header'
import { Reveal } from '@/components/marketing/reveal'

export const metadata: Metadata = {
  title: 'Features',
  description:
    'Explore Unified Communication Portal: one shared inbox for email, Teams, WhatsApp, SMS, Telegram, Messenger, Instagram and website live chat — with AI-drafted replies, role-based access, bring-your-own-credentials, SLA & CSAT tracking and true multi-tenant isolation.',
  alternates: { canonical: '/features' },
}

const GROUPS = [
  {
    eyebrow: 'One inbox',
    title: 'Bring every channel together',
    body: 'Email, Teams, WhatsApp, SMS, Telegram, Messenger, Instagram and an embeddable website live-chat widget all arrive in the same threaded workspace — automatically de-duplicated and organised so nothing is missed.',
    items: [
      { icon: Mail, title: 'Email', body: 'Full IMAP/SMTP sync with proper threading, attachments and Message-ID de-duplication.' },
      { icon: MessagesSquare, title: 'Microsoft Teams', body: 'Internal escalations and team chatter alongside customer conversations.' },
      { icon: MessageSquare, title: 'WhatsApp', body: 'Meet customers on the channel they already use, in the same shared inbox.' },
      { icon: Smartphone, title: 'SMS', body: 'Two-way texting via Twilio — universal, fast, threaded by phone number.' },
      { icon: Send, title: 'Telegram', body: 'Bot-powered Telegram chats, grouped per customer automatically.' },
      { icon: Facebook, title: 'Messenger', body: 'Facebook Page messages answered from the same shared queue.' },
      { icon: Instagram, title: 'Instagram', body: 'Instagram DMs handled right alongside every other channel.' },
      { icon: MessagesSquare, title: 'Website live chat', body: 'An embeddable chat widget — one line of code, real-time replies into the inbox.' },
    ],
  },
  {
    eyebrow: 'Productivity',
    title: 'Move faster, together',
    body: 'Built-in collaboration keeps your whole team aligned on every conversation, with the tools to triage and resolve at speed.',
    items: [
      { icon: Share2, title: 'Assignment & routing', body: 'Send conversations to the right person and avoid two agents replying at once.' },
      { icon: Tag, title: 'Statuses & tags', body: 'Organise by status and custom tags so your queue always reflects reality.' },
      { icon: BookOpen, title: 'Knowledge base', body: 'A shared source of truth so answers stay accurate and on-brand.' },
      { icon: ClipboardList, title: 'Templates & macros', body: 'Save and reuse your best responses for instant, consistent replies.' },
    ],
  },
  {
    eyebrow: 'Intelligence',
    title: 'AI that helps, never overrides',
    body: 'The assistant drafts replies from the full conversation context — your team always reviews and approves before anything is sent.',
    items: [
      { icon: Bot, title: 'AI-drafted replies', body: 'A ready-to-edit response in seconds, grounded in the whole thread.' },
      { icon: Sparkles, title: 'Tone & suggestions', body: 'Smart wording and template suggestions to match your voice.' },
      { icon: ShieldCheck, title: 'Approval-gated sending', body: 'AI never auto-sends — a human approves every customer message.' },
      { icon: Cpu, title: 'Per-role AI models', body: 'Admins choose which AI provider and model each role or user is allowed to use.' },
    ],
  },
  {
    eyebrow: 'Trust & scale',
    title: 'Enterprise-ready foundations',
    body: 'Run many brands from one platform with airtight data separation, granular control and measurable service quality.',
    items: [
      { icon: Building2, title: 'Multi-tenant isolation', body: 'Each company is fully separated with row-level security — data never crosses.' },
      { icon: ShieldCheck, title: 'Role-based access', body: 'An admin console gates sections, channels, AI features and actions — per role and per user.' },
      { icon: KeyRound, title: 'Bring your own credentials', body: 'Connect each tenant’s own provider accounts — encrypted, test-gated, platform defaults as fallback.' },
      { icon: Gauge, title: 'SLA tracking', body: 'Keep your promises with response-time timers and clear visibility.' },
      { icon: ClipboardList, title: 'CSAT surveys', body: 'Measure satisfaction automatically after every resolved conversation.' },
    ],
  },
]

export default function FeaturesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Features"
        title="One platform for every conversation"
        subtitle="From a unified inbox to AI-assisted replies and true multi-tenancy — everything your support team needs, in one place."
      />

      <div className="space-y-20 py-20 sm:space-y-28 sm:py-28">
        {GROUPS.map((g, gi) => (
          <section key={g.title} className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8" aria-label={g.title}>
            <Reveal className="mx-auto max-w-2xl text-center">
              <span className="font-[family-name:var(--font-geist-mono)] text-[12px] tracking-tight text-teal-700">{g.eyebrow}</span>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-zinc-900 sm:text-4xl">{g.title}</h2>
              <p className="mt-4 text-lg text-zinc-600">{g.body}</p>
            </Reveal>
            <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {g.items.map((item, i) => (
                <Reveal key={item.title} delay={(i % 4) * 80}>
                  <div className="group h-full rounded-xl border border-zinc-200 bg-white p-6 transition-colors hover:border-zinc-300">
                    <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-700 ring-1 ring-teal-100">
                      <item.icon className="h-5 w-5" />
                    </div>
                    <h3 className="mt-4 text-base font-semibold text-zinc-900">{item.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-600">{item.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
            {gi < GROUPS.length - 1 && (
              <div className="mx-auto mt-20 h-px max-w-5xl bg-zinc-200 sm:mt-28" />
            )}
          </section>
        ))}
      </div>

      {/* CTA */}
      <section className="py-20">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <Reveal>
            <h2 className="text-3xl font-semibold tracking-[-0.02em] text-zinc-900 sm:text-4xl">
              See it on your own channels
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-zinc-600">
              Request a demo and we’ll show you Unified connected to a live inbox.
            </p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <Link
                href="/contact"
                className="group inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--brand-accent)] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-teal-800"
              >
                Request a demo
                <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
              </Link>
              <Link
                href="/pricing"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-300 px-5 py-3 text-sm font-medium text-zinc-800 transition-colors hover:border-zinc-300 hover:bg-zinc-50"
              >
                View pricing
              </Link>
            </div>
            <p className="mt-6 inline-flex items-center justify-center gap-1.5 text-sm text-zinc-500">
              <Check className="h-4 w-4 text-teal-700" /> Invite-only · onboarding included
            </p>
          </Reveal>
        </div>
      </section>
    </>
  )
}
