import { cn } from '@/lib/utils'
import { getPhaseStatusColor, getPhaseStatusLabel } from '@/lib/utils'

export interface PhaseIndicatorProps {
  phase1_enabled: boolean
  phase2_enabled: boolean
  className?: string
}

export function PhaseIndicator({
  phase1_enabled,
  phase2_enabled,
  className,
}: PhaseIndicatorProps) {
  const dotColor = getPhaseStatusColor(phase1_enabled, phase2_enabled)
  const label = getPhaseStatusLabel(phase1_enabled, phase2_enabled)

  return (
    <span className={cn('inline-flex items-center gap-2 text-sm text-gray-700', className)}>
      <span className={cn('inline-block h-2.5 w-2.5 rounded-full', dotColor)} />
      {label}
    </span>
  )
}
