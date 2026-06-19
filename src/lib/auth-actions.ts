'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { checkRateLimit } from '@/lib/rate-limiter'

/** Best-effort client IP from the proxy headers (Vercel sets x-forwarded-for). */
async function clientIp(): Promise<string> {
  const h = await headers()
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    h.get('x-real-ip')?.trim() ||
    'unknown'
  )
}

export async function signIn(formData: FormData) {
  const email = ((formData.get('email') as string) || '').trim().toLowerCase()
  const password = formData.get('password') as string

  // Throttle credential attempts per-email and per-IP to blunt brute-force /
  // credential-stuffing at the app layer (GoTrue's own throttling is coarse).
  // The limiter fails OPEN, so an outage never locks legitimate users out.
  const ip = await clientIp()
  const ipCheck = await checkRateLimit(`login:ip:${ip}`, 30, 60)
  const emailCheck = email ? await checkRateLimit(`login:email:${email}`, 10, 60) : null
  if (!ipCheck.allowed || (emailCheck && !emailCheck.allowed)) {
    return { error: 'Too many sign-in attempts. Please wait a minute and try again.' }
  }

  const supabase = await createServerSupabaseClient()

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    return { error: error.message }
  }

  // MFA step-up: if this user has a verified second factor, the freshly
  // established session is still aal1 and must be promoted to aal2 via the
  // TOTP challenge before reaching the dashboard.
  //
  // FAIL-OPEN: getAuthenticatorAssuranceLevel can throw (network / GoTrue
  // hiccup). A failure here must NEVER block a legitimate sign-in, so any
  // error falls through to /dashboard. We compute the target inside the
  // try/catch and redirect AFTER it — `redirect()` throws NEXT_REDIRECT
  // internally, so calling it inside the catch-bearing block would let the
  // catch swallow the redirect.
  let target = '/dashboard'
  try {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal && aal.currentLevel === 'aal1' && aal.nextLevel === 'aal2') {
      target = '/account/verify-2fa'
    }
  } catch {
    // Fall through to /dashboard — never lock the user out on a transient error.
  }

  redirect(target)
}

export async function signUp(formData: FormData) {
  const email = ((formData.get('email') as string) || '').trim().toLowerCase()
  const password = formData.get('password') as string
  const fullName = formData.get('fullName') as string

  // Same policy as the invite set-password route — don't trust the client's minLength.
  if (!password || password.length < 8) {
    return { error: 'Password must be at least 8 characters.' }
  }

  // Per-IP throttle so the public signup form can't be used to hammer GoTrue
  // (account-enumeration / mail-bombing). Fails open.
  const ip = await clientIp()
  const ipCheck = await checkRateLimit(`signup:ip:${ip}`, 10, 300)
  if (!ipCheck.allowed) {
    return { error: 'Too many sign-up attempts. Please wait a few minutes and try again.' }
  }

  const supabase = await createServerSupabaseClient()

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
      },
    },
  })

  if (error) {
    return { error: error.message }
  }

  // public.users is created by the `on_auth_user_created` trigger, which also
  // promotes the very first signup to 'admin'. We only need to set full_name here.
  if (data.user && fullName) {
    try {
      const { createServiceRoleClient } = await import('@/lib/supabase-server')
      const serviceClient = await createServiceRoleClient()
      await serviceClient.from('users').update({ full_name: fullName }).eq('id', data.user.id)
    } catch (err) {
      console.error('Failed to set full_name on public.users:', err)
    }
  }

  redirect('/login?message=Account created! You can now sign in.')
}

export async function signOut() {
  const supabase = await createServerSupabaseClient()
  await supabase.auth.signOut()
  redirect('/login')
}
