import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  serverExternalPackages: ['jspdf', 'jspdf-autotable'],
  // (Next 16 no longer runs ESLint during `next build`; lint is enforced as a
  // dedicated CI step via `npm run lint`.)
  // Baseline HTTP security headers applied to every route.
  async headers() {
    // ── Content-Security-Policy: REPORT-ONLY rollout (observe, don't block) ──
    // Emitted as `Content-Security-Policy-Report-Only` so browsers REPORT
    // violations to /api/csp-report but block nothing — an imperfect policy
    // can't break the app. We deliberately bias permissive here (v1); we'll
    // tighten directives later from the real violation reports.
    //
    // connect-src MUST list the Supabase origins or realtime/REST/storage
    // light up the console (still not blocked, but noisy):
    //   - https://*.supabase.co  → REST + Storage  (NEXT_PUBLIC_SUPABASE_URL)
    //   - wss://*.supabase.co    → Realtime websockets
    // Wildcards (not the hardcoded project ref) keep this portable across
    // environments where NEXT_PUBLIC_SUPABASE_URL differs. The Sentry tunnel
    // (/monitoring) is same-origin so 'self' already covers it.
    //
    // Notable allowances:
    //   - script-src 'unsafe-inline' 'unsafe-eval' → Next.js dev/runtime + the
    //       inline JSON-LD on the marketing pages. (Permissive for v1.)
    //   - style-src  'unsafe-inline'               → Next/Tailwind inject inline styles.
    //   - img-src    data:                         → MFA QR code is a data:image/svg+xml URI.
    //                blob:/https:                  → next/image + remote avatars.
    //   - font-src   data:                         → inlined/data-URI fonts.
    const cspReportOnly = [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "report-uri /api/csp-report",
      "report-to csp-endpoint",
    ].join('; ')

    // Reporting API group that the `report-to` directive above points at.
    const reportTo = JSON.stringify({
      group: 'csp-endpoint',
      max_age: 10886400,
      endpoints: [{ url: '/api/csp-report' }],
    })

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
          { key: 'Content-Security-Policy-Report-Only', value: cspReportOnly },
          { key: 'Report-To', value: reportTo },
        ],
      },
    ]
  },
}

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  tunnelRoute: '/monitoring', // proxies Sentry through our domain to bypass ad blockers
  sourcemaps: { disable: true }, // don't ship source maps publicly (was hideSourceMaps in older versions)
  disableLogger: true,
})
