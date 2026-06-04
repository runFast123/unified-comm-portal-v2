import * as Sentry from '@sentry/nextjs'

const dsn = process.env.SENTRY_DSN
if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    enabled: process.env.NODE_ENV === 'production' || process.env.SENTRY_DEV === '1',
    environment: process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,

    /**
     * Pull request_id off the current scope and pin it to the event tags +
     * extra fields. The scope is populated by:
     *   1. logger.ts — captureMessage() with explicit `tags.request_id`
     *   2. middleware (`src/middleware.ts`) — Sentry.setTag('request_id', …)
     *      on the inbound request scope, so any uncaught exception that
     *      bubbles up gets tagged automatically.
     *   3. instrumentation.ts onRequestError — explicit tag at capture time.
     * The redundancy is intentional: any one of these can mint the tag, and
     * beforeSend just makes sure it survives onto the final event payload.
     */
    beforeSend(event) {
      try {
        const scope = Sentry.getCurrentScope()
        // Sentry's Scope shape is internal; cast through unknown to read the
        // scope id without pulling a private type.
        const scopeData = (scope as unknown as { _tags?: Record<string, string> })._tags
        const scopeRequestId = scopeData?.request_id
        if (scopeRequestId) {
          event.tags = { request_id: scopeRequestId, ...(event.tags ?? {}) }
        }
      } catch {
        // Never let beforeSend block error reporting.
      }
      return event
    },
  })
}
