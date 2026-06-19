import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// Re-export the canonical Skeleton so there is a single implementation
// app-wide. The `Skeleton` / `SkeletonProps` names stay importable from here.
export { Skeleton } from '@/components/ui/skeleton'
export type { SkeletonProps } from '@/components/ui/skeleton'

export interface SpinnerProps {
  size?: number
  className?: string
}

export function Spinner({ size = 24, className }: SpinnerProps) {
  return (
    <Loader2
      size={size}
      className={cn('animate-spin text-primary', className)}
    />
  )
}

export interface LoadingProps {
  label?: string
  className?: string
}

export function Loading({ label = 'Loading...', className }: LoadingProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 py-16', className)}>
      <Spinner size={32} />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  )
}
