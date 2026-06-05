'use client'

// ── Set-password landing for invited users ──────────────────────────────────
// This is a TOP-LEVEL app route (NOT under (auth) or (dashboard)) on purpose:
//
//   - The (dashboard) layout redirects anyone without an auth user to /login
//     and assumes a fully-provisioned profile. An invitee arriving here has
//     only a fresh token-session (mid-setup) and would be bounced.
//   - The (auth) layout doesn't redirect, but it wraps children in its own
//     logo/card chrome; this page renders its own chrome so it can also show
//     the "invalid link" state cleanly.
//
// A top-level route gets ONLY the root layout, so the page controls its own
// shell. Supabase's invite link carries the token in the URL *hash*
// (#access_token=...&type=invite), which the @supabase/ssr browser client
// auto-detects on load to establish a session. NOTE: middleware can't see the
// hash, so /accept-invite must be allow-listed in src/middleware.ts (alongside
// /csat) or an unauthenticated invitee is redirected to /login before this
// component ever runs.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Lock, CheckCircle2, AlertCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase-client'

type Phase = 'checking' | 'ready' | 'saving' | 'success' | 'invalid'

// Pull an `error` / `error_description` out of the URL hash (Supabase puts
// auth errors there, e.g. an expired or already-consumed invite link).
function readHashError(): string | null {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const desc = params.get('error_description')
  const err = params.get('error')
  if (desc) return desc.replace(/\+/g, ' ')
  if (err) return err.replace(/\+/g, ' ')
  return null
}

function AcceptInviteCard() {
  const router = useRouter()
  const [supabase] = useState(() => createClient())

  const [phase, setPhase] = useState<Phase>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Custom admin-issued setup token (from #setup=<token>). When present we use
  // the prefetch-safe /api/auth/set-password flow instead of a GoTrue session.
  const [setupToken, setSetupToken] = useState<string | null>(null)

  // On mount, wait for the browser client to consume the invite token in the
  // URL hash and establish a session. The token→session exchange is async, so
  // we poll getSession a few times with a short delay before giving up.
  useEffect(() => {
    let cancelled = false

    // Custom admin-issued setup link: #setup=<token>. This path does NOT use a
    // GoTrue session — the token is validated server-side on submit, so it's
    // immune to the single-use / prefetch / expiry fragility of recovery links.
    const rawHash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash
    const setupTok = new URLSearchParams(rawHash).get('setup')
    if (setupTok) {
      setSetupToken(setupTok)
      // Strip the token from the URL so it doesn't linger in the address bar.
      window.history.replaceState(null, '', window.location.pathname)
      setPhase('ready')
      return
    }

    // If the link itself carried an auth error, surface it immediately —
    // there will never be a session to wait for.
    const hashError = readHashError()
    if (hashError) {
      setError(hashError)
      setPhase('invalid')
      return
    }

    // Catch the session the instant the token→session exchange completes.
    // detectSessionInUrl runs asynchronously, and onAuthStateChange fires for
    // the resulting SIGNED_IN / PASSWORD_RECOVERY event even if our getSession
    // polls happen to race ahead of it.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled || !session) return
      // Only open the initial gate (checking → ready). Never let a late auth
      // event override a terminal/in-progress phase (saving/success/invalid).
      setPhase((p) => (p === 'checking' ? 'ready' : p))
    })

    async function waitForSession() {
      for (let attempt = 0; attempt < 8; attempt++) {
        const { data } = await supabase.auth.getSession()
        if (cancelled) return
        if (data.session) {
          setPhase((p) => (p === 'checking' ? 'ready' : p))
          return
        }
        // Short backoff to let detectSessionInUrl finish the hash exchange.
        await new Promise((r) => setTimeout(r, 400))
      }
      // No session and no explicit error hash: the token was missing, already
      // used, or expired. Only fail if we're still on the initial gate — don't
      // clobber a phase a concurrent auth event already advanced.
      if (!cancelled) setPhase((p) => (p === 'checking' ? 'invalid' : p))
    }

    void waitForSession()
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [supabase])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError(null)

      if (password.length < 8) {
        setError('Password must be at least 8 characters.')
        return
      }
      if (password !== confirm) {
        setError('Passwords do not match.')
        return
      }

      setPhase('saving')

      // ── Custom setup-token flow (prefetch-safe; validated + set server-side) ──
      if (setupToken) {
        try {
          const res = await fetch('/api/auth/set-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: setupToken, password }),
          })
          const j = (await res.json().catch(() => ({}))) as { error?: string }
          if (!res.ok) {
            setError(j?.error || 'Could not set your password.')
            // 400 = invalid/expired/used token → terminal; else allow a retry.
            setPhase(res.status === 400 ? 'invalid' : 'ready')
            return
          }
          setPhase('success')
          setTimeout(
            () =>
              router.push(
                '/login?message=' +
                  encodeURIComponent('Password set! Please sign in with your new password.')
              ),
            1200
          )
        } catch {
          setError('Network error — please try again.')
          setPhase('ready')
        }
        return
      }

      // ── GoTrue hash-session flow (real invite / recovery emails) ──
      // Make sure we still hold a live session before updating. A recovery /
      // invite session can lapse while the form sits open, and a no-session
      // updateUser would silently leave the OLD password in place — exactly the
      // failure that let a "set" password never actually save.
      const { data: sessionData } = await supabase.auth.getSession()
      if (!sessionData.session) {
        setError('Your set-password link has expired. Ask your admin for a fresh link.')
        setPhase('invalid')
        return
      }

      const { data, error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError || !data?.user) {
        setError(
          updateError?.message ||
            'Could not set your password. Request a fresh link and try again.'
        )
        setPhase('ready')
        return
      }

      // Password committed. Drop the temporary recovery/invite session and send
      // them to the login form to sign in with their NEW password. This proves
      // the new password works and removes the "I'm in the app but my password
      // never changed" ambiguity that made the old password keep working.
      await supabase.auth.signOut().catch(() => {})
      // Drop any residual recovery/invite token still in the URL hash so the
      // navigation to /login can't be re-forwarded back here by the login
      // page's hash handler (it would strand the user on a now-consumed token).
      if (typeof window !== 'undefined' && window.location.hash) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
      }
      setPhase('success')
      setTimeout(
        () =>
          router.push(
            '/login?message=' +
              encodeURIComponent('Password set! Please sign in with your new password.')
          ),
        1200
      )
    },
    [password, confirm, supabase, router, setupToken]
  )

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-teal-800 via-teal-600 to-emerald-700 relative overflow-hidden">
      {/* Background decoration — mirrors (auth)/layout.tsx */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-teal-500/20 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-96 w-96 rounded-full bg-teal-400/10 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md px-4 animate-fade-in">
        <div className="rounded-2xl bg-white/95 backdrop-blur-sm p-8 shadow-2xl border border-white/20">
          {/* Logo */}
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-600 to-teal-700 shadow-lg shadow-teal-600/30">
              <svg className="h-7 w-7 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Set your password</h1>
            <p className="mt-2 text-sm text-gray-500">
              Choose a password to finish setting up your account.
            </p>
          </div>

          {/* ── Checking for the invite session ───────────────────────────── */}
          {phase === 'checking' && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <Loader2 className="h-6 w-6 animate-spin text-teal-600" />
              <p className="text-sm text-gray-500">Verifying your invite link…</p>
            </div>
          )}

          {/* ── Invalid / expired link ────────────────────────────────────── */}
          {phase === 'invalid' && (
            <div className="space-y-5">
              <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-100 p-3 text-sm text-red-600">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  {error ??
                    'This invite link is invalid or has expired — ask your admin to re-invite you.'}
                </span>
              </div>
              <Link
                href="/login"
                className="block w-full rounded-lg bg-gradient-to-r from-teal-700 to-teal-600 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-sm shadow-teal-700/25 transition-all hover:from-teal-800 hover:to-teal-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-teal-500/50"
              >
                Go to sign in
              </Link>
            </div>
          )}

          {/* ── Success ───────────────────────────────────────────────────── */}
          {phase === 'success' && (
            <div className="flex flex-col items-center justify-center gap-3 py-6">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-teal-50">
                <CheckCircle2 className="h-7 w-7 text-teal-600" />
              </div>
              <p className="text-sm font-medium text-gray-800">Password set! Taking you to sign in…</p>
              <Loader2 className="h-4 w-4 animate-spin text-teal-600" />
            </div>
          )}

          {/* ── Set-password form ─────────────────────────────────────────── */}
          {(phase === 'ready' || phase === 'saving') && (
            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-100 p-3 text-sm text-red-600">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label
                  htmlFor="password"
                  className="mb-1.5 block text-sm font-medium text-gray-700"
                >
                  New password
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
                    autoComplete="new-password"
                    placeholder="••••••••"
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={phase === 'saving'}
                    className="w-full rounded-lg border border-gray-300 py-2.5 pl-10 pr-4 text-sm transition-all focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 hover:border-gray-400 disabled:opacity-60"
                  />
                </div>
                <p className="mt-1.5 text-xs text-gray-400">Must be at least 8 characters</p>
              </div>

              <div>
                <label
                  htmlFor="confirm"
                  className="mb-1.5 block text-sm font-medium text-gray-700"
                >
                  Confirm password
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                    <Lock className="h-4 w-4 text-gray-400" />
                  </div>
                  <input
                    id="confirm"
                    name="confirm"
                    type="password"
                    required
                    autoComplete="new-password"
                    placeholder="••••••••"
                    minLength={8}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    disabled={phase === 'saving'}
                    className="w-full rounded-lg border border-gray-300 py-2.5 pl-10 pr-4 text-sm transition-all focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 hover:border-gray-400 disabled:opacity-60"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={phase === 'saving'}
                className="w-full rounded-lg bg-gradient-to-r from-teal-700 to-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-teal-700/25 transition-all hover:from-teal-800 hover:to-teal-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-teal-500/50 disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none flex items-center justify-center gap-2"
              >
                {phase === 'saving' && <Loader2 className="h-4 w-4 animate-spin" />}
                {phase === 'saving' ? 'Saving…' : 'Set password & continue'}
              </button>
            </form>
          )}
        </div>

        {/* Footer — mirrors (auth)/layout.tsx */}
        <p className="mt-6 text-center text-xs text-teal-200/60">
          Powered by AI &middot; Teams &middot; Email &middot; WhatsApp
        </p>
      </div>
    </div>
  )
}

export default function AcceptInvitePage() {
  return <AcceptInviteCard />
}
