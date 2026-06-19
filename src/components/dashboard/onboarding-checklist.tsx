'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, X, Sparkles, ArrowRight } from 'lucide-react'
import { useUser } from '@/context/user-context'
import { cn } from '@/lib/utils'

const DISMISS_KEY = 'onboarding-checklist-dismissed'

type StepId = 'add_account' | 'configure_credentials' | 'invite_teammate' | 'first_reply'

interface StepStatus {
  id: StepId
  complete: boolean
}

interface StepMeta {
  id: StepId
  title: string
  description: string
  href: string
  cta: string
}

const STEPS: StepMeta[] = [
  {
    id: 'add_account',
    title: 'Add your first account',
    description: 'Connect a company inbox to start receiving messages.',
    href: '/admin/channels',
    cta: 'Add account',
  },
  {
    id: 'configure_credentials',
    title: 'Configure channel credentials',
    description: 'Set SMTP, Microsoft Graph, or WhatsApp credentials.',
    href: '/admin/channels',
    cta: 'Configure',
  },
  {
    id: 'invite_teammate',
    title: 'Invite a teammate',
    description: 'Bring in agents so they can triage and reply.',
    href: '/admin/users',
    cta: 'Invite',
  },
  {
    id: 'first_reply',
    title: 'Send your first reply',
    description: 'Reply to a customer message to complete setup.',
    href: '/inbox',
    cta: 'Open inbox',
  },
]

export function OnboardingChecklist() {
  const { isAdmin } = useUser()
  const [statuses, setStatuses] = useState<StepStatus[] | null>(null)
  const [allComplete, setAllComplete] = useState(false)
  const [dismissed, setDismissed] = useState<boolean | null>(null)

  // Read dismissed flag after mount (avoids SSR hydration mismatch)
  useEffect(() => {
    if (typeof window === 'undefined') return
    setDismissed(window.localStorage.getItem(DISMISS_KEY) === '1')
  }, [])

  // Fetch status — only for admins who haven't dismissed
  useEffect(() => {
    if (!isAdmin || dismissed !== false) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/onboarding/status', { cache: 'no-store' })
        if (!res.ok) return
        const json = (await res.json()) as { steps: StepStatus[]; allComplete: boolean }
        if (cancelled) return
        setStatuses(json.steps || [])
        setAllComplete(!!json.allComplete)
      } catch {
        /* silent */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isAdmin, dismissed])

  const handleDismiss = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DISMISS_KEY, '1')
    }
    setDismissed(true)
  }

  // Guards — hide in every self-hide condition
  if (!isAdmin) return null
  if (dismissed !== false) return null // still loading (null) or explicitly dismissed (true)
  if (!statuses) return null
  if (allComplete) return null

  const completedCount = statuses.filter((s) => s.complete).length
  const progressPct = Math.round((completedCount / STEPS.length) * 100)

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border border-border bg-card p-6',
        'shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]'
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700 ring-1 ring-teal-200">
            <Sparkles className="h-4.5 w-4.5" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Getting started
            </p>
            <h3 className="mt-0.5 text-[15px] font-semibold leading-tight text-foreground">
              Finish setting up your workspace
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Four quick steps to get your team replying.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss onboarding checklist"
          className="flex-shrink-0 rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Progress bar */}
      <div className="mt-4 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <span className="text-xs font-medium tabular-nums tracking-tight text-muted-foreground">
          {completedCount} of {STEPS.length} complete
        </span>
      </div>

      {/* Steps */}
      <ul className="mt-5 space-y-2">
        {STEPS.map((step) => {
          const status = statuses.find((s) => s.id === step.id)
          const complete = !!status?.complete
          return (
            <li
              key={step.id}
              className={cn(
                'flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors',
                complete ? 'opacity-80' : 'hover:border-border hover:bg-zinc-50/60'
              )}
            >
              {/* Check icon */}
              <div
                className={cn(
                  'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ring-1',
                  complete
                    ? 'bg-emerald-500 text-white ring-emerald-500'
                    : 'bg-card text-zinc-300 ring-border'
                )}
              >
                <Check className="h-3.5 w-3.5" strokeWidth={3} />
              </div>

              {/* Title + description */}
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm font-semibold', complete ? 'text-muted-foreground line-through' : 'text-foreground')}>
                  {step.title}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{step.description}</p>
              </div>

              {/* Right side */}
              <div className="flex-shrink-0">
                {complete ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                    <Check className="h-3 w-3" strokeWidth={3} /> Done
                  </span>
                ) : (
                  <Link
                    href={step.href}
                    className="inline-flex items-center gap-1 rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2"
                  >
                    {step.cta}
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
