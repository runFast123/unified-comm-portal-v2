import * as Sentry from '@sentry/nextjs'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN
if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    enabled: process.env.NODE_ENV === 'production',
    environment: process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
    // Dial down browser noise — filter out the browser-extension hydration warnings we already suppress.
    beforeSend(event) {
      const msg = event.message || event.exception?.values?.[0]?.value || ''
      if (/Hydration failed because the server rendered HTML/i.test(msg)) return null
      if (/__processed_/.test(msg)) return null
      return event
    },
  })
}
