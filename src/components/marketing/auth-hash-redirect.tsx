'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Supabase invite / password-recovery links redirect to the project's **Site
 * URL** (the root "/") whenever their requested `redirect_to` (`/accept-invite`)
 * isn't in the Auth "Redirect URLs" allow-list. The root is now the marketing
 * landing page, so without this the invite token — or an expired-link error —
 * arrives in the URL *hash* here and is stranded (the marketing page ignores
 * it). The root used to redirect to /login, which already forwards these.
 *
 * Detect such a hash on mount and forward it — intact — to /accept-invite,
 * which consumes the token to establish a session (set-password form) or shows
 * the "link expired" state. Mirrors the same logic in src/app/(auth)/login.
 *
 * Renders nothing.
 */
export function AuthHashRedirect() {
  const router = useRouter()
  useEffect(() => {
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (!hash || hash.length < 2) return
    const params = new URLSearchParams(hash.replace(/^#/, ''))
    const type = params.get('type')
    const isInviteToken =
      params.has('access_token') &&
      (type === 'invite' || type === 'recovery' || type === 'signup')
    // Supabase auth errors (e.g. expired/used link) land here as
    // #error=...&error_code=otp_expired&error_description=... — match all three
    // keys so a bare #error=access_denied is forwarded too (mirrors the broader
    // predicate /accept-invite's readHashError uses).
    const isAuthError =
      params.has('error') || params.has('error_code') || params.has('error_description')
    if (isInviteToken || isAuthError) {
      router.replace('/accept-invite' + hash)
    }
  }, [router])
  return null
}
