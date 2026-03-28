'use client'

import { useEffect } from 'react'
import { AlertTriangle, Inbox } from 'lucide-react'
import Link from 'next/link'

export default function InboxError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Inbox error:', error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6 animate-in fade-in duration-500">
      <div className="w-full max-w-md text-center">
        {/* Alert icon */}
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
          <AlertTriangle className="h-8 w-8 text-red-600" />
        </div>

        {/* Heading */}
        <h2 className="mt-6 text-2xl font-bold text-gray-900">
          Failed to load inbox
        </h2>
        <p className="mt-2 text-sm text-gray-500">
          We couldn&apos;t load your inbox messages. This may be a temporary issue.
        </p>

        {/* Error message box */}
        <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="text-sm text-gray-600 break-words">
            {error.message || 'An unknown error occurred'}
          </p>
        </div>

        {/* Actions */}
        <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <button
            onClick={reset}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-teal-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2"
          >
            <Inbox className="h-4 w-4" />
            Try Again
          </button>
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2"
          >
            Go to Dashboard
          </Link>
        </div>
      </div>
    </div>
  )
}
