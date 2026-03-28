'use client'

function SkeletonBox({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 bg-[length:200%_100%] ${className}`}
      style={{ animation: 'shimmer 1.5s ease-in-out infinite' }}
    />
  )
}

export default function DashboardPageLoading() {
  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      {/* Header skeleton */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <SkeletonBox className="h-7 w-40" />
          <SkeletonBox className="mt-2 h-4 w-64" />
        </div>
        <SkeletonBox className="h-10 w-48 rounded-lg" />
      </div>

      {/* KPI Row - 6 cards matching xl:grid-cols-6 layout */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="relative rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
          >
            <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-gray-200" />
            <div className="flex items-start justify-between">
              <SkeletonBox className="h-4 w-24" />
              <SkeletonBox className="h-10 w-10 rounded-lg" />
            </div>
            <SkeletonBox className="mt-3 h-8 w-16" />
            <SkeletonBox className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>

      {/* Channel Breakdown + Category Breakdown */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Channel Breakdown skeleton */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <SkeletonBox className="h-5 w-40" />
          <SkeletonBox className="mt-1 h-3 w-56" />
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="rounded-lg border border-gray-100 p-4 text-center"
              >
                <SkeletonBox className="mx-auto h-5 w-20" />
                <SkeletonBox className="mx-auto mt-3 h-9 w-12" />
                <SkeletonBox className="mx-auto mt-1 h-3 w-16" />
                <SkeletonBox className="mx-auto mt-3 h-3 w-28" />
                <SkeletonBox className="mt-3 h-1 w-full rounded-full" />
              </div>
            ))}
          </div>
        </div>

        {/* Category Breakdown skeleton */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <SkeletonBox className="h-5 w-44" />
          <SkeletonBox className="mt-1 h-3 w-60" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <SkeletonBox className="h-4 w-32 flex-shrink-0" />
                <SkeletonBox className="h-6 flex-1" />
                <SkeletonBox className="h-4 w-8" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Accounts Overview Table skeleton */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <SkeletonBox className="h-5 w-48" />
        <SkeletonBox className="mt-1 h-3 w-72" />
        <div className="mt-4 space-y-3">
          {/* Table header */}
          <SkeletonBox className="h-10 w-full rounded-md" />
          {/* Table rows */}
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonBox key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </div>
  )
}
