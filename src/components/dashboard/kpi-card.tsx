import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

/** Maps a text color class to its corresponding bg and text class pair for the icon container. */
const COLOR_ICON_BG_MAP: Record<string, string> = {
  'text-teal-600': 'bg-teal-100 text-teal-600',
  'text-blue-600': 'bg-blue-100 text-blue-600',
  'text-green-600': 'bg-green-100 text-green-600',
  'text-red-600': 'bg-red-100 text-red-600',
  'text-yellow-600': 'bg-yellow-100 text-yellow-600',
  'text-purple-600': 'bg-purple-100 text-purple-600',
  'text-orange-600': 'bg-orange-100 text-orange-600',
  'text-pink-600': 'bg-pink-100 text-pink-600',
  'text-indigo-600': 'bg-indigo-100 text-indigo-600',
  'text-cyan-600': 'bg-cyan-100 text-cyan-600',
  'text-gray-600': 'bg-gray-100 text-gray-600',
}

/** Maps a text color class to its corresponding accent bar bg class. */
const COLOR_ACCENT_MAP: Record<string, string> = {
  'text-teal-600': 'bg-teal-600',
  'text-blue-600': 'bg-blue-600',
  'text-green-600': 'bg-green-600',
  'text-red-600': 'bg-red-600',
  'text-yellow-600': 'bg-yellow-600',
  'text-purple-600': 'bg-purple-600',
  'text-orange-600': 'bg-orange-600',
  'text-pink-600': 'bg-pink-600',
  'text-indigo-600': 'bg-indigo-600',
  'text-cyan-600': 'bg-cyan-600',
  'text-gray-600': 'bg-gray-600',
}

export interface KPICardProps {
  title: string
  value: string | number
  subtitle?: string
  trend?: 'up' | 'down' | 'neutral'
  trendLabel?: string
  icon: LucideIcon
  color?: string
  alert?: boolean
}

export function KPICard({
  title,
  value,
  subtitle,
  trend,
  trendLabel,
  icon: Icon,
  color = 'text-teal-600',
  alert = false,
}: KPICardProps) {
  const trendIcon =
    trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus
  const TrendIcon = trendIcon

  const trendColor =
    trend === 'up'
      ? 'text-green-600'
      : trend === 'down'
        ? 'text-red-500'
        : 'text-gray-400'

  return (
    <div
      className={cn(
        'relative rounded-xl border bg-white p-5 shadow-sm transition-shadow hover:shadow-md',
        alert ? 'border-red-300' : 'border-gray-200'
      )}
    >
      {/* Colored accent bar */}
      <div
        className={cn(
          'absolute left-0 top-0 h-full w-1 rounded-l-xl',
          alert ? 'bg-red-500' : (COLOR_ACCENT_MAP[color] || 'bg-teal-600')
        )}
      />

      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="mt-1 text-3xl font-bold text-gray-900">{value}</p>
          {subtitle && (
            <p className="mt-1 text-xs text-gray-400">{subtitle}</p>
          )}
          {trend && (
            <div className={cn('mt-2 flex items-center gap-1 text-xs font-medium', trendColor)}>
              <TrendIcon className="h-3.5 w-3.5" />
              {trendLabel && <span>{trendLabel}</span>}
            </div>
          )}
        </div>
        <div
          className={cn(
            'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg',
            alert ? 'bg-red-100 text-red-600' : (COLOR_ICON_BG_MAP[color] || 'bg-teal-100 text-teal-600')
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
      </div>

      {alert && (
        <span className="absolute -right-1 -top-1 flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
        </span>
      )}
    </div>
  )
}
