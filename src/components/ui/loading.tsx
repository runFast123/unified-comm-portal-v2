import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SpinnerProps {
  size?: number
  className?: string
}

export function Spinner({ size = 24, className }: SpinnerProps) {
  return (
    <Loader2
      size={size}
      className={cn('animate-spin text-teal-700', className)}
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
      <p className="text-sm text-gray-500">{label}</p>
    </div>
  )
}

export interface SkeletonProps {
  className?: string
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-md bg-gray-200',
        className
      )}
    />
  )
}
