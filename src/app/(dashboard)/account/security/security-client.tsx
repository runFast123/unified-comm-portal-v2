'use client'

/**
 * Two-factor authentication (TOTP) management — Stage 1 (opt-in MFA).
 *
 * Flow:
 *   - On load, list factors. A VERIFIED `totp` factor means 2FA is ON.
 *   - Enable: enroll → render QR + manual secret → user enters a 6-digit code
 *     → challenge + verify. On success the session is promoted to aal2.
 *   - Disable: unenroll the verified factor (requires aal2, which an enrolled
 *     user has after the login challenge / right after enrolling).
 *
 * All MFA calls run against the BROWSER Supabase client because they operate
 * on the live client session (enroll/verify promote the current session to
 * aal2). The server never sees the TOTP secret.
 *
 * Stale-factor hygiene: if the user starts enrolling and walks away without
 * verifying, we best-effort unenroll the dangling unverified factor (on
 * cancel and on unmount) so unverified factors don't pile up. Supabase
 * normally allows only one unverified factor at a time, so leaving one behind
 * would block a future enrollment attempt.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase-client'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { Loader2, ShieldCheck, ShieldOff, Copy, Check } from 'lucide-react'

type Phase = 'loading' | 'idle_off' | 'idle_on' | 'enrolling'

interface EnrollData {
  factorId: string
  qrCode: string
  secret: string
}

// Accept only 6 digits; trim spaces some authenticator apps insert.
function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6)
}

export default function SecurityClient() {
  const supabase = createClient()
  const { toast } = useToast()
  const confirm = useConfirm()

  const [phase, setPhase] = useState<Phase>('loading')
  const [verifiedFactorId, setVerifiedFactorId] = useState<string | null>(null)

  // Enrollment-in-progress state.
  const [enroll, setEnroll] = useState<EnrollData | null>(null)
  const [code, setCode] = useState('')
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)

  // Track the unverified factor id so we can clean it up if the user bails.
  // A ref (not state) so the unmount cleanup reads the latest value without
  // re-running the effect.
  const pendingFactorRef = useRef<string | null>(null)

  // ── Best-effort cleanup of a dangling unverified factor ──────────────
  const cleanupPendingFactor = useCallback(async () => {
    const factorId = pendingFactorRef.current
    if (!factorId) return
    pendingFactorRef.current = null
    try {
      await supabase.auth.mfa.unenroll({ factorId })
    } catch {
      /* best-effort — a leftover unverified factor isn't fatal */
    }
  }, [supabase])

  // ── Load current factor state ────────────────────────────────────────
  const refresh = useCallback(async () => {
    setPhase('loading')
    try {
      const { data, error } = await supabase.auth.mfa.listFactors()
      if (error) throw error
      // `data.totp` is the verified-only TOTP list; `data.all` includes
      // unverified ones too. A verified TOTP factor = 2FA is ON.
      const verified = (data?.totp ?? []).find((f) => f.status === 'verified')
        ?? (data?.all ?? []).find((f) => f.factor_type === 'totp' && f.status === 'verified')
      if (verified) {
        setVerifiedFactorId(verified.id)
        setPhase('idle_on')
      } else {
        setVerifiedFactorId(null)
        setPhase('idle_off')
      }
    } catch (err) {
      toast.error(`Could not load two-factor status: ${(err as Error).message}`)
      // Fail to the "off" view so the page is still usable; the enable flow
      // will surface any real error again.
      setVerifiedFactorId(null)
      setPhase('idle_off')
    }
  }, [supabase, toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Clean up an abandoned, unverified factor if the user navigates away
  // mid-enrollment.
  useEffect(() => {
    return () => {
      void cleanupPendingFactor()
    }
  }, [cleanupPendingFactor])

  // ── Begin enrollment ─────────────────────────────────────────────────
  const handleEnable = useCallback(async () => {
    setSubmitting(true)
    setVerifyError(null)
    try {
      // Clear any prior dangling unverified factor first so enroll() doesn't
      // fail with "factor already exists".
      await cleanupPendingFactor()

      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Authenticator app',
      })
      if (error) throw error
      if (data.type !== 'totp') throw new Error('Unexpected factor type returned')

      pendingFactorRef.current = data.id
      setEnroll({
        factorId: data.id,
        // qr_code is already a full `data:image/svg+xml;utf-8,...` URI in
        // @supabase/auth-js — render directly, do NOT re-prefix it.
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
      })
      setCode('')
      setPhase('enrolling')
    } catch (err) {
      toast.error(`Could not start enrollment: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }, [supabase, toast, cleanupPendingFactor])

  // ── Verify the 6-digit code → finish enrollment ──────────────────────
  const handleVerify = useCallback(async () => {
    if (!enroll) return
    const clean = normalizeCode(code)
    if (clean.length !== 6) {
      setVerifyError('Enter the 6-digit code from your authenticator app.')
      return
    }
    setSubmitting(true)
    setVerifyError(null)
    try {
      // challengeAndVerify = challenge() + verify() in one call. On success
      // the current session is promoted to aal2.
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId: enroll.factorId,
        code: clean,
      })
      if (error) {
        // Wrong/expired code is the common case — keep the user on the form.
        setVerifyError(
          'That code was not accepted. Check your authenticator app and try again.'
        )
        setCode('')
        return
      }
      // Verified — this factor is now permanent; clear the cleanup guard so
      // unmount doesn't unenroll it.
      pendingFactorRef.current = null
      setEnroll(null)
      setCode('')
      toast.success('Two-factor authentication is on.')
      await refresh()
    } catch (err) {
      setVerifyError(`Verification failed: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }, [enroll, code, supabase, toast, refresh])

  // ── Cancel an in-progress enrollment ─────────────────────────────────
  const handleCancelEnroll = useCallback(async () => {
    setEnroll(null)
    setCode('')
    setVerifyError(null)
    await cleanupPendingFactor()
    await refresh()
  }, [cleanupPendingFactor, refresh])

  // ── Turn 2FA off ─────────────────────────────────────────────────────
  const handleDisable = useCallback(async () => {
    if (!verifiedFactorId) return
    const ok = await confirm({
      title: 'Turn off two-factor authentication?',
      message:
        'Your account will no longer require a code at sign-in. You can turn it back on at any time.',
      confirmText: 'Turn off',
      danger: true,
    })
    if (!ok) return
    setSubmitting(true)
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: verifiedFactorId })
      if (error) throw error
      toast.success('Two-factor authentication is off.')
      await refresh()
    } catch (err) {
      toast.error(`Could not turn off two-factor authentication: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }, [verifiedFactorId, confirm, supabase, toast, refresh])

  const handleCopySecret = useCallback(async () => {
    if (!enroll) return
    try {
      await navigator.clipboard.writeText(enroll.secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy. Select the code and copy it manually.')
    }
  }, [enroll, toast])

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Two-factor authentication</h1>
        <p className="mt-1 text-sm text-gray-500">
          Add a second step at sign-in using an authenticator app (Google
          Authenticator, 1Password, Authy, etc.). When on, you&apos;ll enter a
          6-digit code after your password.
        </p>
      </div>

      {phase === 'loading' && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
          <span className="ml-3 text-gray-500">Loading security settings...</span>
        </div>
      )}

      {phase === 'idle_on' && (
        <Card>
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-100">
                <ShieldCheck className="h-5 w-5 text-green-700" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  Two-factor authentication is on
                </h2>
                <p className="mt-0.5 text-sm text-gray-500">
                  Your account is protected with an authenticator app. You&apos;ll
                  be asked for a code each time you sign in on a new session.
                </p>
              </div>
            </div>
            <div className="flex justify-end border-t border-gray-100 pt-4">
              <Button variant="danger" onClick={handleDisable} loading={submitting} disabled={submitting}>
                <ShieldOff size={14} />
                Turn off
              </Button>
            </div>
          </div>
        </Card>
      )}

      {phase === 'idle_off' && (
        <Card>
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100">
                <ShieldOff className="h-5 w-5 text-gray-500" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  Two-factor authentication is off
                </h2>
                <p className="mt-0.5 text-sm text-gray-500">
                  Turn it on to require a one-time code from your authenticator
                  app in addition to your password.
                </p>
              </div>
            </div>
            <div className="flex justify-end border-t border-gray-100 pt-4">
              <Button variant="primary" onClick={handleEnable} loading={submitting} disabled={submitting}>
                <ShieldCheck size={14} />
                Enable two-factor authentication
              </Button>
            </div>
          </div>
        </Card>
      )}

      {phase === 'enrolling' && enroll && (
        <Card>
          <div className="space-y-5">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">
                Scan this QR code
              </h2>
              <p className="mt-0.5 text-sm text-gray-500">
                Open your authenticator app and scan the code below, or enter the
                setup key manually.
              </p>
            </div>

            <div className="flex flex-col items-start gap-5 sm:flex-row">
              {/* QR — qr_code is already a data:image/svg+xml URI. */}
              <div className="rounded-lg border border-gray-200 bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={enroll.qrCode}
                  alt="Two-factor authentication QR code"
                  width={176}
                  height={176}
                  className="h-44 w-44"
                />
              </div>

              <div className="flex-1 space-y-2">
                <label className="block text-xs font-medium text-gray-700">
                  Or enter this setup key manually
                </label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-md border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-sm text-gray-800">
                    {enroll.secret}
                  </code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleCopySecret}
                    aria-label="Copy setup key"
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>
            </div>

            <div className="border-t border-gray-100 pt-4">
              <label htmlFor="totp-code" className="mb-1.5 block text-sm font-medium text-gray-700">
                Enter the 6-digit code
              </label>
              <div className="flex items-start gap-3">
                <div className="w-40">
                  <Input
                    id="totp-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    value={code}
                    maxLength={6}
                    error={verifyError ?? undefined}
                    onChange={(e) => {
                      setCode(normalizeCode(e.target.value))
                      if (verifyError) setVerifyError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleVerify()
                    }}
                    autoFocus
                  />
                </div>
                <Button
                  variant="primary"
                  onClick={handleVerify}
                  loading={submitting}
                  disabled={submitting || normalizeCode(code).length !== 6}
                >
                  Verify &amp; turn on
                </Button>
                <Button variant="ghost" onClick={handleCancelEnroll} disabled={submitting}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
