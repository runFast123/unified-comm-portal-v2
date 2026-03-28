'use client'

function SkeletonBox({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 bg-[length:200%_100%] ${className}`}
      style={{ animation: 'shimmer 1.5s ease-in-out infinite' }}
    />
  )
}

export default function InboxLoading() {
  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      {/* Page header */}
      <div>
        <SkeletonBox className="h-7 w-32" />
        <SkeletonBox className="mt-2 h-4 w-56" />
      </div>

      {/* Filter bar skeleton */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <SkeletonBox className="h-9 w-36 rounded-md" />
        <SkeletonBox className="h-9 w-32 rounded-md" />
        <SkeletonBox className="h-9 w-32 rounded-md" />
        <SkeletonBox className="h-9 w-28 rounded-md" />
        <div className="flex-1" />
        <SkeletonBox className="h-9 w-48 rounded-md" />
      </div>

      {/* Action bar skeleton */}
      <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
        <SkeletonBox className="h-5 w-5 rounded" />
        <SkeletonBox className="h-4 w-24" />
        <div className="flex-1" />
        <SkeletonBox className="h-8 w-24 rounded-md" />
        <SkeletonBox className="h-8 w-24 rounded-md" />
        <SkeletonBox className="h-8 w-28 rounded-md" />
      </div>

      {/* Inbox rows skeleton - 8 rows */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className={`flex items-center gap-4 px-4 py-3.5 ${
              i < 7 ? 'border-b border-gray-100' : ''
            }`}
          >
            {/* Checkbox */}
            <SkeletonBox className="h-5 w-5 flex-shrink-0 rounded" />
            {/* Priority indicator */}
            <SkeletonBox className="h-5 w-5 flex-shrink-0 rounded-full" />
            {/* Channel icon */}
            <SkeletonBox className="h-5 w-5 flex-shrink-0 rounded" />
            {/* Sender / account */}
            <div className="flex-shrink-0" style={{ width: '140px' }}>
              <SkeletonBox className="h-4 w-full" />
              <SkeletonBox className="mt-1 h-3 w-20" />
            </div>
            {/* Subject / snippet */}
            <div className="min-w-0 flex-1">
              <SkeletonBox className="h-4 w-3/4" />
              <SkeletonBox className="mt-1 h-3 w-1/2" />
            </div>
            {/* Category badge */}
            <SkeletonBox className="h-6 w-20 flex-shrink-0 rounded-full" />
            {/* Sentiment badge */}
            <SkeletonBox className="h-6 w-16 flex-shrink-0 rounded-full" />
            {/* AI status */}
            <SkeletonBox className="h-6 w-20 flex-shrink-0 rounded-full" />
            {/* Time */}
            <SkeletonBox className="h-4 w-12 flex-shrink-0" />
          </div>
        ))}
      </div>
    </div>
  )
}
