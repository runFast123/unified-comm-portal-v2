import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

/**
 * Per-color theme map. Each entry defines the full visual treatment so the
 * card can be coloured by passing one `color` prop (e.g. "teal", "blue") and
 * everything — gradient background, icon container, accent bar, ring on
 * hover — stays consistent.
 *
 * Tailwind needs full literal class names at build time, which is why we
 * spell them out here instead of templating.
 */
type ColorTheme = {
  bg: string         // gradient background of the card
  ring: string       // hover ring colour
  iconBg: string     // gradient background behind the icon
  iconText: string   // icon colour
  accent: string     // left accent bar colour
}

const THEMES: Record<string, ColorTheme> = {
  teal:    { bg: 'from-teal-50/60 to-white',     ring: 'hover:ring-teal-200/60',    iconBg: 'from-teal-500 to-teal-600',     iconText: 'text-white', accent: 'bg-teal-500' },
  blue:    { bg: 'from-blue-50/60 to-white',     ring: 'hover:ring-blue-200/60',    iconBg: 'from-blue-500 to-blue-600',     iconText: 'text-white', accent: 'bg-blue-500' },
  green:   { bg: 'from-green-50/60 to-white',    ring: 'hover:ring-green-200/60',   iconBg: 'from-green-500 to-green-600',   iconText: 'text-white', accent: 'bg-green-500' },
  emerald: { bg: 'from-emerald-50/60 to-white',  ring: 'hover:ring-emerald-200/60', iconBg: 'from-emerald-500 to-emerald-600', iconText: 'text-white', accent: 'bg-emerald-500' },
  red:     { bg: 'from-red-50/60 to-white',      ring: 'hover:ring-red-200/60',     iconBg: 'from-red-500 to-red-600',       iconText: 'text-white', accent: 'bg-red-500' },
  yellow:  { bg: 'from-yellow-50/60 to-white',   ring: 'hover:ring-yellow-200/60',  iconBg: 'from-yellow-500 to-amber-500',  iconText: 'text-white', accent: 'bg-yellow-500' },
  amber:   { bg: 'from-amber-50/60 to-white',    ring: 'hover:ring-amber-200/60',   iconBg: 'from-amber-500 to-orange-500',  iconText: 'text-white', accent: 'bg-amber-500' },
  orange:  { bg: 'from-orange-50/60 to-white',   ring: 'hover:ring-orange-200/60',  iconBg: 'from-orange-500 to-orange-600', iconText: 'text-white', accent: 'bg-orange-500' },
  purple:  { bg: 'from-purple-50/60 to-white',   ring: 'hover:ring-purple-200/60',  iconBg: 'from-purple-500 to-purple-600', iconText: 'text-white', accent: 'bg-purple-500' },
  pink:    { bg: 'from-pink-50/60 to-white',     ring: 'hover:ring-pink-200/60',    iconBg: 'from-pink-500 to-pink-600',     iconText: 'text-white', accent: 'bg-pink-500' },
  indigo:  { bg: 'from-indigo-50/60 to-white',   ring: 'hover:ring-indigo-200/60',  iconBg: 'from-indigo-500 to-indigo-600', iconText: 'text-white', accent: 'bg-indigo-500' },
  cyan:    { bg: 'from-cyan-50/60 to-white',     ring: 'hover:ring-cyan-200/60',    iconBg: 'from-cyan-500 to-cyan-600',     iconText: 'text-white', accent: 'bg-cyan-500' },
  gray:    { bg: 'from-gray-50/60 to-white',     ring: 'hover:ring-gray-200/60',    iconBg: 'from-gray-500 to-gray-600',     iconText: 'text-white', accent: 'bg-gray-500' },
}

/**
 * Backward-compat: callers pass strings like "text-teal-600". Strip the
 * prefix/suffix and look up the theme. Falls back to teal.
 */
function resolveTheme(color?: string): ColorTheme {
  if (!color) return THEMES.teal
  // direct key match (new style: color="teal")
  if (THEMES[color]) return THEMES[color]
  // legacy "text-teal-600" → "teal"
  const legacy = color.replace(/^text-/, '').replace(/-\d+$/, '')
  return THEMES[legacy] ?? THEMES.teal
}

const ALERT_THEME: ColorTheme = {
  bg: 'from-red-50 to-red-50/40',
  ring: 'hover:ring-red-200',
  iconBg: 'from-red-500 to-red-600',
  iconText: 'text-white',
  accent: 'bg-red-500',
}

export interface KPICardProps {
  title: string
  value: string | number
  subtitle?: string
  trend?: 'up' | 'down' | 'neutral'
  trendLabel?: string
  icon: LucideIcon
  /** Color name ("teal", "blue", …) or legacy "text-teal-600" string. */
  color?: string
  alert?: boolean
  /** Make the card a clickable affordance (e.g. drill-down on dashboard). */
  onClick?: () => void
  /** Highlight the card as the currently-selected drill-down. */
  active?: boolean
}

export function KPICard({
  title,
  value,
  subtitle,
  trend,
  trendLabel,
  icon: Icon,
  color = 'teal',
  alert = false,
  onClick,
  active = false,
}: KPICardProps) {
  const theme = alert ? ALERT_THEME : resolveTheme(color)
  const clickable = !!onClick

  const trendIcon =
    trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus
  const TrendIcon = trendIcon

  // Trend rendered as a coloured pill — much clearer than a single coloured
  // icon next to grey text.
  const trendPill =
    trend === 'up'
      ? 'bg-green-50 text-green-700 ring-1 ring-green-200/70'
      : trend === 'down'
        ? 'bg-red-50 text-red-700 ring-1 ring-red-200/70'
        : 'bg-gray-50 text-gray-600 ring-1 ring-gray-200/70'

  const Wrapper = clickable ? 'button' : 'div'

  return (
    <Wrapper
      onClick={onClick}
      type={clickable ? 'button' : undefined}
      className={cn(
        'group relative w-full overflow-hidden rounded-2xl border bg-gradient-to-br p-5 shadow-sm text-left',
        'ring-1 transition-all duration-200',
        clickable && 'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        'hover:-translate-y-0.5 hover:shadow-md',
        alert ? 'border-red-200' : 'border-gray-200/80',
        active ? 'ring-2 shadow-md' : 'ring-transparent hover:ring-1',
        active
          ? `${theme.accent.replace('bg-', 'ring-')}`
          : theme.ring,
        theme.bg,
      )}
    >
      {/* Soft decorative blob in the corner — adds depth without being noisy */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full opacity-30 blur-2xl transition-opacity group-hover:opacity-50',
          'bg-gradient-to-br',
          theme.iconBg,
        )}
      />

      {/* Left accent bar — thinner + rounded for a refined look */}
      <div
        className={cn(
          'absolute left-0 top-3 bottom-3 w-1 rounded-r-full',
          theme.accent,
        )}
      />

      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {title}
          </p>
          <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums text-gray-900">
            {value}
          </p>
          {subtitle && (
            <p className="mt-1 text-xs text-gray-500">{subtitle}</p>
          )}
          {trend && trendLabel && (
            <span
              className={cn(
                'mt-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                trendPill,
              )}
            >
              <TrendIcon className="h-3 w-3" />
              {trendLabel}
            </span>
          )}
        </div>
        <div
          className={cn(
            'relative flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl shadow-sm bg-gradient-to-br',
            theme.iconBg,
            theme.iconText,
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
      </div>

      {alert && (
        <span className="absolute right-3 top-3 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
        </span>
      )}
    </Wrapper>
  )
}
