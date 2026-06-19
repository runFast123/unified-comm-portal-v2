'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Loader2, Mail, Lock, CheckCircle2, AlertCircle } from 'lucide-react'
import { signIn } from '@/lib/auth-actions'

function LoginForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const searchParams = useSearchParams()
  const message = searchParams.get('message')

  // Invite / password-recovery links carry their token in the URL *hash*
  // (#access_token=...&type=invite|recovery|signup). Supabase sometimes lands
  // these on the Site URL root / login instead of /accept-invite. If we detect
  // such a token here, forward it (hash intact) to the set-password page so the
  // invitee can choose a password — otherwise they'd be stuck on this form with
  // no password to enter ("Invalid login credentials").
  useEffect(() => {
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (!hash || !hash.includes('access_token')) return
    const params = new URLSearchParams(hash.replace(/^#/, ''))
    const type = params.get('type')
    if (type === 'recovery' || type === 'invite' || type === 'signup') {
      router.replace('/accept-invite' + hash)
    }
  }, [router])

  async function handleSubmit(formData: FormData) {
    setError(null)
    setLoading(true)
    try {
      const result = await signIn(formData)
      if (result?.error) {
        setError(result.error)
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message?.includes('NEXT_REDIRECT')) {
        throw err
      }
      setError('An unexpected error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {message && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-teal-50 border border-teal-100 p-3 text-sm text-teal-700">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          <span>{message}</span>
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-red-50 border border-red-100 p-3 text-sm text-red-600">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form action={handleSubmit} className="space-y-5">
        <div>
          <label
            htmlFor="email"
            className="mb-1.5 block text-sm font-medium text-gray-700"
          >
            Email address
          </label>
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
              <Mail className="h-4 w-4 text-gray-400" />
            </div>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              className="w-full rounded-lg border border-border py-2.5 pl-10 pr-4 text-sm transition-all focus:border-[var(--brand-accent)] hover:border-zinc-400"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="password"
            className="mb-1.5 block text-sm font-medium text-gray-700"
          >
            Password
          </label>
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
              <Lock className="h-4 w-4 text-gray-400" />
            </div>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
              className="w-full rounded-lg border border-border py-2.5 pl-10 pr-4 text-sm transition-all focus:border-[var(--brand-accent)] hover:border-zinc-400"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-[var(--brand-accent)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-teal-700/25 transition-all hover:brightness-110 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-teal-500/50 disabled:cursor-not-allowed disabled:bg-[var(--brand-accent)]/70 disabled:shadow-none flex items-center justify-center gap-2"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>

      <p className="mt-6 text-center text-xs text-zinc-500">
        Access is invite-only. Ask your administrator to add you, then use the
        set-password link they share.
      </p>
    </>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-teal-600" />
      </div>
    }>
      <LoginForm />
    </Suspense>
  )
}
