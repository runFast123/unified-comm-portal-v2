import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const REQUEST_ID_HEADER = 'x-request-id'
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/

/**
 * Either accept the upstream request id (if it matches our pattern) or mint
 * a fresh UUID. Mirrors `src/lib/request-id.ts` — duplicated here because
 * Next 16 middleware runs on the Edge runtime, which exposes Web Crypto
 * (crypto.randomUUID) but NOT the Node `crypto` module.
 */
function resolveRequestId(req: NextRequest): string {
  const incoming = req.headers.get(REQUEST_ID_HEADER)
  if (incoming && REQUEST_ID_PATTERN.test(incoming)) return incoming
  // crypto is available globally on Edge + Node 16+; use the standard
  // Web Crypto UUID generator so this file stays Edge-compatible.
  return crypto.randomUUID()
}

export async function middleware(request: NextRequest) {
  // ── 1. Resolve a request id BEFORE any other work so every downstream
  //    handler (including Supabase auth probe + redirects) carries the same
  //    id. We inject it into the *forwarded* request headers via
  //    NextResponse.next({ request: { headers } }) — that's how Next 16
  //    persists per-request headers across middleware → route boundaries.
  const requestId = resolveRequestId(request)
  const forwardedHeaders = new Headers(request.headers)
  forwardedHeaders.set(REQUEST_ID_HEADER, requestId)

  // Best-effort Sentry scope tag. Wrapped in try/catch + dynamic import so a
  // missing DSN / failed import never blocks the request. Edge-runtime
  // compatible (uses @sentry/nextjs).
  try {
    const SentryMod = await import('@sentry/nextjs').catch(() => null)
    if (SentryMod && process.env.SENTRY_DSN) {
      const scope = SentryMod.getCurrentScope?.()
      scope?.setTag?.('request_id', requestId)
      scope?.setTag?.('route', request.nextUrl.pathname)
    }
  } catch {
    // never let observability break the request
  }

  let supabaseResponse = NextResponse.next({
    request: { headers: forwardedHeaders },
  })
  supabaseResponse.headers.set(REQUEST_ID_HEADER, requestId)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // If Supabase credentials are not configured yet, allow all requests through.
  // Response still carries the x-request-id header set above.
  if (!supabaseUrl || !supabaseAnonKey) {
    return supabaseResponse
  }

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          // Re-create the response, BUT keep our forwarded headers (incl.
          // x-request-id) so the request id survives the cookie reset path.
          supabaseResponse = NextResponse.next({
            request: { headers: forwardedHeaders },
          })
          supabaseResponse.headers.set(REQUEST_ID_HEADER, requestId)
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  // Redirect authenticated users away from auth pages
  if (user && (pathname === '/login' || pathname === '/signup')) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    const redirect = NextResponse.redirect(url)
    redirect.headers.set(REQUEST_ID_HEADER, requestId)
    return redirect
  }

  // Redirect unauthenticated users to login
  if (
    !user &&
    pathname !== '/login' &&
    pathname !== '/signup' &&
    !pathname.startsWith('/api/') &&
    !pathname.startsWith('/_next/') &&
    // Public CSAT survey landing — customers click these from email and
    // never authenticate. The token in the URL is the auth.
    !pathname.startsWith('/csat/')
  ) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    const redirect = NextResponse.redirect(url)
    redirect.headers.set(REQUEST_ID_HEADER, requestId)
    return redirect
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (images, etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
