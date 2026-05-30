import Link from 'next/link'

/**
 * Brand logo: the conversation-bubble mark + "Unified" wordmark. Matches the
 * teal gradient used across the auth screens and the app shell. Pass
 * `href={null}` to render the mark without a link (e.g. inside the footer).
 */
export function Logo({
  className = '',
  textClassName = 'text-gray-900',
  href = '/',
  showText = true,
}: {
  className?: string
  textClassName?: string
  href?: string | null
  showText?: boolean
}) {
  const inner = (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-teal-600 to-teal-700 shadow-md shadow-teal-600/30">
        <svg
          className="h-5 w-5 text-white"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.8}
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
          />
        </svg>
      </span>
      {showText && (
        <span className={`text-lg font-bold tracking-tight ${textClassName}`}>Unified</span>
      )}
    </span>
  )
  if (href === null) return inner
  return (
    <Link href={href} aria-label="Unified — home" className="inline-flex">
      {inner}
    </Link>
  )
}
