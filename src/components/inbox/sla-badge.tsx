'use client'

import { useMemo, useState, useEffect } from 'react'
import { cn } from '@/lib/utils'

// Default SLA thresholds (hours)
const DEFAULT_WARNING_HOURS = 2
const DEFAULT_CRITICAL_HOURS = 4

interface SLABadgeProps {
  receivedAt: string | null | undefined
  /** Override default 2h warning threshold */
  warningHours?: number
  /** Override default 4h critical threshold */
  criticalHours?: number
  /** Conversation status - only show for pending/active conversations */
  conversationStatus?: string | null
  className?: string
}

function formatWaitTime(diffMs: number): string {
  const totalMins = Math.floor(diffMs / 60000)
  if (totalMins < 1) return '< 1m'
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours < 1) return `${mins}m`
  if (hours < 24) return `${hours}h ${mins}m`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return `${days}d ${remainingHours}h`
}

type SLALevel = 'ok' | 'warning' | 'critical'

function getSLALevel(diffMs: number, warningHours: number, criticalHours: number): SLALevel {
  const hours = diffMs / (1000 * 60 * 60)
  if (hours >= criticalHours) return 'critical'
  if (hours >= warningHours) return 'warning'
  return 'ok'
}

const levelConfig: Record<SLALevel, { bg: string; text: string; border: string; dot?: string }> = {
  ok: {
    bg: 'bg-green-50',
    text: 'text-green-700',
    border: 'border-green-200',
  },
  warning: {
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    border: 'border-amber-200',
  },
  critical: {
    bg: 'bg-red-50',
    text: 'text-red-700',
    border: 'border-red-200',
    dot: 'bg-red-500',
  },
}

/**
 * SLA wait time badge. Displays elapsed time since message was received
 * with color coding based on SLA thresholds.
 * Only renders for non-resolved/non-archived conversations.
 */
export function SLABadge({
  receivedAt,
  warningHours = DEFAULT_WARNING_HOURS,
  criticalHours = DEFAULT_CRITICAL_HOURS,
  conversationStatus,
  className,
}: SLABadgeProps) {
  // Auto-update every 60 seconds
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(interval)
  }, [])

  // Don't show for resolved/archived conversations
  const hiddenStatuses = ['resolved', 'archived']
  if (conversationStatus && hiddenStatuses.includes(conversationStatus)) {
    return null
  }

  if (!receivedAt) return null

  const receivedTime = new Date(receivedAt).getTime()
  if (isNaN(receivedTime)) return null

  const diffMs = now - receivedTime
  if (diffMs < 0) return null

  const level = getSLALevel(diffMs, warningHours, criticalHours)
  const config = levelConfig[level]
  const timeStr = formatWaitTime(diffMs)

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap',
        config.bg,
        config.text,
        config.border,
        className,
      )}
      title={`Wait time: ${timeStr} (Warning: ${warningHours}h, Critical: ${criticalHours}h)`}
    >
      {level === 'critical' && (
        <span className={cn('inline-block h-1.5 w-1.5 rounded-full animate-pulse', config.dot)} />
      )}
      {level === 'warning' && <span className="text-[10px]">!</span>}
      {timeStr}
      {level === 'critical' && <span className="hidden sm:inline text-[10px]">SLA</span>}
    </span>
  )
}
