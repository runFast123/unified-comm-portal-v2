'use client'

// Root error boundary. Next renders this IN PLACE OF the root layout when an
// error is thrown in the layout itself or in a route with no closer boundary —
// so it must render its own <html>/<body> and can't rely on global CSS being
// loaded (hence inline styles). It also forwards the error to Sentry, closing
// the "white screen with no report" gap the segment boundaries didn't cover.

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          background: '#f9fafb',
          color: '#111827',
        }}
      >
        <div style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>
          <div
            style={{
              margin: '0 auto',
              height: 64,
              width: 64,
              borderRadius: '9999px',
              background: '#fee2e2',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 30,
            }}
            aria-hidden
          >
            ⚠️
          </div>
          <h1 style={{ marginTop: 24, fontSize: 24, fontWeight: 700 }}>Something went wrong</h1>
          <p style={{ marginTop: 8, fontSize: 14, color: '#6b7280' }}>
            An unexpected error occurred. Our team has been notified.
          </p>
          {error?.digest && (
            <p style={{ marginTop: 8, fontSize: 12, color: '#9ca3af' }}>Reference: {error.digest}</p>
          )}
          <div
            style={{
              marginTop: 24,
              display: 'flex',
              gap: 12,
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <button
              onClick={() => reset()}
              style={{
                cursor: 'pointer',
                borderRadius: 8,
                border: 'none',
                background: '#0d9488',
                color: '#fff',
                padding: '10px 20px',
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              Try again
            </button>
            <a
              href="/dashboard"
              style={{
                borderRadius: 8,
                border: '1px solid #d1d5db',
                background: '#fff',
                color: '#374151',
                padding: '10px 20px',
                fontSize: 14,
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              Go to dashboard
            </a>
          </div>
        </div>
      </body>
    </html>
  )
}
