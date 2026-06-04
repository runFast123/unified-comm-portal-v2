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
  // Baseline HTTP security headers applied to every route. (CSP is intentionally
  // omitted here — it needs a report-only rollout first to avoid breaking inline
  // styles/scripts — and is tracked as a follow-up.)
  async headers() {
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
