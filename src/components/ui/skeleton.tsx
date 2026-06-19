'use client'

import { cn } from '@/lib/utils'

// ─── Base Skeleton ───────────────────────────────────────────────
export interface SkeletonProps {
  className?: string
  width?: string
  height?: string
  rounded?: string
}

/**
 * Low-level pulsing placeholder block. Single canonical shimmer treatment for
 * the whole app — a token-driven `animate-pulse bg-muted` block. Pass className
 * overrides (e.g. `h-4 w-20 rounded-full`) for specific shapes.
 */
export function Skeleton({ className, width, height, rounded }: SkeletonProps) {
  return (
    <div
      className={cn(
        'animate-pulse bg-muted',
        rounded ?? 'rounded-md',
        className
      )}
      style={{ width, height }}
    />
  )
}

// ─── Text Skeleton ───────────────────────────────────────────────
export interface SkeletonTextProps {
  /** Number of lines to render (default 3). */
  lines?: number
  className?: string
}

/**
 * Renders N lines of varying-width placeholder text. Widths cycle so the
 * paragraph doesn't look like a uniform block.
 */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  const widths = ['w-11/12', 'w-full', 'w-9/12', 'w-10/12', 'w-8/12']
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn('h-3', widths[i % widths.length])}
        />
      ))}
    </div>
  )
}

// ─── Card Skeleton (mimics KPI card) ─────────────────────────────
export interface SkeletonCardProps {
  className?: string
}

/**
 * Card-shaped placeholder styled to mirror the real Card primitive —
 * matching rounded-xl radius, tokenized surface + border, soft shadow,
 * label + large value + subtitle stack, icon chip in the corner.
 */
export function SkeletonCard({ className }: SkeletonCardProps) {
  return (
    <div
      className={cn(
        'relative flex flex-col overflow-hidden rounded-xl border border-border bg-card p-5 shadow-sm',
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-3 w-24 rounded-full" />
        <Skeleton className="h-9 w-9 rounded-xl" />
      </div>
      <Skeleton className="mt-3 h-8 w-20 rounded" />
      <div className="mt-2 flex items-center gap-2">
        <Skeleton className="h-4 w-14 rounded-full" />
        <Skeleton className="h-3 w-20 rounded" />
      </div>
    </div>
  )
}

// ─── Inbox Row Skeleton ──────────────────────────────────────────
/**
 * One row of the inbox list — avatar + two text lines + trailing meta.
 * Used in the inbox page loading state so the layout doesn't shift in.
 */
export function InboxRowSkeleton() {
  // Geometry mirrors the real InboxRow outer container + internal layout
  // (src/components/inbox/inbox-row.tsx): gap-4 px-5 py-4, min-h-[64px],
  // bottom border, a leading channel chip + fixed-width sender column
  // (round avatar + two text lines), a flex-1 subject line, and a
  // horizontally-laid trailing meta row — so real rows swap in without a jump.
  return (
    <div className="flex items-center gap-4 border-b border-border px-5 py-4 min-h-[64px]">
      {/* Checkbox */}
      <Skeleton className="h-4 w-4 flex-shrink-0 rounded" />
      {/* Channel chip */}
      <Skeleton className="h-7 w-7 flex-shrink-0 rounded-full" />
      {/* Sender column: avatar + name/subline (fixed width, matches w-48 md:w-56 xl:w-80) */}
      <div className="flex w-48 flex-shrink-0 items-center gap-3 md:w-56 xl:w-80">
        <Skeleton className="h-9 w-9 flex-shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-28 rounded" />
          <Skeleton className="h-2.5 w-20 rounded" />
        </div>
      </div>
      {/* Subject / preview — single line, flex-1 */}
      <div className="min-w-0 flex-1 pr-2">
        <Skeleton className="h-3.5 w-3/4 rounded" />
      </div>
      {/* Trailing meta — laid out horizontally to match the real row's pills/dots */}
      <div className="flex flex-shrink-0 items-center gap-2">
        <Skeleton className="hidden h-2.5 w-2.5 rounded-full md:block" />
        <Skeleton className="hidden h-3 w-16 rounded md:block" />
        <Skeleton className="h-5 w-14 rounded-full" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
    </div>
  )
}

// ─── KPI Card Skeleton (alias) ───────────────────────────────────
/** Legacy alias kept so older imports don't break. Prefer SkeletonCard. */
export const KPICardSkeleton = SkeletonCard

// ─── Conversation Skeleton ───────────────────────────────────────
/**
 * Alternating message-bubble skeleton used in the conversation detail
 * loading state — two inbound bubbles on the left, two outbound on the right.
 */
export function ConversationSkeleton() {
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start gap-2">
        <Skeleton className="h-8 w-8 flex-shrink-0 rounded-full" />
        <div className="space-y-1.5">
          <Skeleton className="h-16 w-64 rounded-2xl rounded-tl-sm" />
          <Skeleton className="h-3 w-16 rounded" />
        </div>
      </div>
      <div className="flex items-start justify-end gap-2">
        <div className="flex flex-col items-end space-y-1.5">
          <Skeleton className="h-12 w-48 rounded-2xl rounded-tr-sm" />
          <Skeleton className="h-3 w-12 rounded" />
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Skeleton className="h-8 w-8 flex-shrink-0 rounded-full" />
        <div className="space-y-1.5">
          <Skeleton className="h-20 w-56 rounded-2xl rounded-tl-sm" />
          <Skeleton className="h-3 w-16 rounded" />
        </div>
      </div>
      <div className="flex items-start justify-end gap-2">
        <div className="flex flex-col items-end space-y-1.5">
          <Skeleton className="h-10 w-40 rounded-2xl rounded-tr-sm" />
          <Skeleton className="h-3 w-12 rounded" />
        </div>
      </div>
    </div>
  )
}
