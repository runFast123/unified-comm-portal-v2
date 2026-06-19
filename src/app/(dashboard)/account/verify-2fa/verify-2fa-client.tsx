'use client'

/**
 * Login-time second-factor challenge.
 *
 * Reached after a password sign-in when the user has a verified TOTP factor
 * but the current session is still aal1 (see `signIn` in auth-actions and the
 * enforce-for-enrolled gate in the dashboard layout). The user enters their
 * 6-digit code; on success the session is promoted to aal2 and we leave for
 * the dashboard (or the `next` param, if it's a safe in-app path).
 *
 * Runs against the BROWSER Supabase client because the verify call promotes
 * the live client session.
 *
 * Escape hatch: a "Sign out" action (the server `signOut`) so a user who
 * can't produce a code is never trapped on this screen.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-client'
import { signOut } from '@/lib/auth-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, ShieldCheck } from 'lucide-react'

function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6)
}

/**
 * Only honour a `next` target that is a same-origin app path (starts with a
 * single `/`, not `//` or a scheme). Prevents an open-redirect via
 * `?next=https://evil.example`.
 */
function safeNext(next: string | null): string {
  if (!next) return '/dashboard'
  // Reject anything that isn't an unambiguous same-origin path: must start
  // with a single '/', and no backslashes (some parsers treat '\' as '/', a
  // known open-redirect vector).
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/dashboard'
  // Don't bounce straight back to this page.
  if (next.startsWith('/account/verify-2fa')) return '/dashboard'
  return next
}

export default function Verify2faClient({ next }: { next: string | null }) {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const destination = safeNext(next)

  // Resolve the verified TOTP factor to challenge.
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const { data, error: listErr } = await supabase.auth.mfa.listFactors()
        if (listErr) throw listErr
        const verified = (data?.totp ?? []).find((f) => f.status === 'verified')
          ?? (data?.all ?? []).find((f) => f.factor_type === 'totp' && f.status === 'verified')
        if (cancelled) return
        if (verified) {
          setFactorId(verified.id)
        } else {
          // No verified factor → nothing to step up. The layout gate won't
          // hold them here, so send them on.
          router.replace(destination)
          return
        }
      } catch {
        if (!cancelled) {
          setError('Could not load your authentication factors. Try signing out and back in.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [supabase, router, destination])

  const handleVerify = useCallback(async () => {
    if (!factorId) return
    const clean = normalizeCode(code)
    if (clean.length !== 6) {
      setError('Enter the 6-digit code from your authenticator app.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code: clean,
      })
      if (verifyErr) {
        setError('That code was not accepted. Check your authenticator app and try again.')
        setCode('')
        return
      }
      // Session is now aal2. Use replace so Back doesn't return to the
      // challenge, and refresh so the server layout re-reads the new AAL.
      router.replace(destination)
      router.refresh()
    } catch (err) {
      setError(`Verification failed: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }, [factorId, code, supabase, router, destination])

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-teal-100">
            <ShieldCheck className="h-6 w-6 text-teal-700" />
          </span>
          <h1 className="text-xl font-bold text-gray-900">Two-factor authentication</h1>
          <p className="mt-1 text-sm text-gray-500">
            Enter the 6-digit code from your authenticator app to finish signing in.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-7 w-7 animate-spin text-teal-600" />
          </div>
        ) : (
          <div className="space-y-4">
            <Input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              maxLength={6}
              error={error ?? undefined}
              onChange={(e) => {
                setCode(normalizeCode(e.target.value))
                if (error) setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleVerify()
              }}
              autoFocus
              disabled={!factorId}
            />
            <Button
              variant="primary"
              onClick={handleVerify}
              loading={submitting}
              disabled={submitting || !factorId || normalizeCode(code).length !== 6}
              className="w-full"
            >
              Verify
            </Button>

            {/* Escape hatch — a stuck user can always sign out. */}
            <form action={signOut} className="pt-2 text-center">
              <button
                type="submit"
                className="text-sm font-medium text-gray-500 underline-offset-2 hover:text-gray-700 hover:underline"
              >
                Sign out
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
