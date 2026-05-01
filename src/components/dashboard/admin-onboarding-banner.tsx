'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles, X, Activity, Building2 } from 'lucide-react'

const DISMISS_KEY = 'admin-onboarding-banner-dismissed-v1'

interface AdminOnboardingBannerProps {
  /** True only when the current user can act on the banner. */
  show: boolean
}

/**
 * One-time onboarding hint shown to fresh super_admins on a brand-new
 * deploy (single company in the system). Auto-hides once dismissed —
 * dismissal is stored in `localStorage` under `admin-onboarding-banner-dismissed-v1`,
 * so it stays gone across page refreshes for that browser.
 *
 * Server gates `show` on (role === super_admin AND companies.count === 1)
 * so we don't render anything for normal users or for fully-onboarded
 * environments.
 */
export function AdminOnboardingBanner({ show }: AdminOnboardingBannerProps) {
  const [dismissed, setDismissed] = useState(true) // start hidden, flip after mount check

  useEffect(() => {
    if (!show) return
    if (typeof window === 'undefined') return
    setDismissed(localStorage.getItem(DISMISS_KEY) === 'true')
  }, [show])

  const dismiss = () => {
    setDismissed(true)
    if (typeof window !== 'undefined') {
      localStorage.setItem(DISMISS_KEY, 'true')
    }
  }

  if (!show || dismissed) return null

  return (
    <div
      role="status"
      className="mx-4 mt-4 flex items-start gap-3 rounded-xl border border-teal-200 bg-gradient-to-r from-teal-50 to-emerald-50 px-4 py-3 shadow-sm md:mx-6 lg:mx-8"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-600 text-white shadow">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-teal-900">
          You&rsquo;re an admin!
        </p>
        <p className="mt-0.5 text-sm text-teal-800">
          Visit{' '}
          <Link
            href="/admin/health"
            className="inline-flex items-center gap-1 font-medium text-teal-700 underline-offset-2 hover:underline"
          >
            <Activity className="h-3.5 w-3.5" />
            /admin/health
          </Link>{' '}
          to verify your setup, then{' '}
          <Link
            href="/admin/companies"
            className="inline-flex items-center gap-1 font-medium text-teal-700 underline-offset-2 hover:underline"
          >
            <Building2 className="h-3.5 w-3.5" />
            /admin/companies
          </Link>{' '}
          to add your first company.
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss onboarding hint"
        className="shrink-0 rounded-md p-1 text-teal-700 transition-colors hover:bg-teal-100 hover:text-teal-900"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
