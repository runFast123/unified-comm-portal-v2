'use client'

import { cn } from '@/lib/utils'

// ─── Base Skeleton ───────────────────────────────────────────────
export interface SkeletonProps {
  className?: string
  width?: string
  height?: string
  rounded?: string
}

export function Skeleton({ className, width, height, rounded }: SkeletonProps) {
  return (
    <div
      className={cn(
        'animate-pulse bg-gray-200',
        rounded ?? 'rounded-md',
        className
      )}
      style={{ width, height }}
    />
  )
}

// ─── Inbox Row Skeleton ──────────────────────────────────────────
export function InboxRowSkeleton() {
  return (
    <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
      {/* Checkbox */}
      <Skeleton className="h-4 w-4 rounded" />
      {/* Avatar */}
      <Skeleton className="h-9 w-9 flex-shrink-0 rounded-full" />
      {/* Content lines */}
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-28 rounded" />
          <Skeleton className="h-3 w-16 rounded" />
        </div>
        <Skeleton className="h-3 w-3/4 rounded" />
      </div>
      {/* Badge / time */}
      <div className="flex flex-col items-end gap-1.5">
        <Skeleton className="h-3 w-12 rounded" />
        <Skeleton className="h-5 w-14 rounded-full" />
      </div>
    </div>
  )
}

// ─── KPI Card Skeleton ───────────────────────────────────────────
export function KPICardSkeleton() {
  return (
    <div className="relative rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      {/* Accent bar */}
      <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-gray-200" />
      <div className="flex items-start justify-between">
        <div className="flex-1 space-y-3">
          <Skeleton className="h-4 w-24 rounded" />
          <Skeleton className="h-8 w-16 rounded" />
          <Skeleton className="h-3 w-20 rounded" />
        </div>
        <Skeleton className="h-10 w-10 rounded-lg" />
      </div>
    </div>
  )
}

// ─── Conversation Skeleton ───────────────────────────────────────
export function ConversationSkeleton() {
  return (
    <div className="space-y-4 p-4">
      {/* Incoming bubble */}
      <div className="flex items-start gap-2">
        <Skeleton className="h-8 w-8 flex-shrink-0 rounded-full" />
        <div className="space-y-1.5">
          <Skeleton className="h-16 w-64 rounded-2xl rounded-tl-sm" />
          <Skeleton className="h-3 w-16 rounded" />
        </div>
      </div>
      {/* Outgoing bubble */}
      <div className="flex items-start justify-end gap-2">
        <div className="space-y-1.5 flex flex-col items-end">
          <Skeleton className="h-12 w-48 rounded-2xl rounded-tr-sm" />
          <Skeleton className="h-3 w-12 rounded" />
        </div>
      </div>
      {/* Incoming bubble */}
      <div className="flex items-start gap-2">
        <Skeleton className="h-8 w-8 flex-shrink-0 rounded-full" />
        <div className="space-y-1.5">
          <Skeleton className="h-20 w-56 rounded-2xl rounded-tl-sm" />
          <Skeleton className="h-3 w-16 rounded" />
        </div>
      </div>
      {/* Outgoing bubble */}
      <div className="flex items-start justify-end gap-2">
        <div className="space-y-1.5 flex flex-col items-end">
          <Skeleton className="h-10 w-40 rounded-2xl rounded-tr-sm" />
          <Skeleton className="h-3 w-12 rounded" />
        </div>
      </div>
    </div>
  )
}
