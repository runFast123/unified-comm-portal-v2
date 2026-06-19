import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

/**
 * Per-color theme map. Each entry defines the card's color-coding only: a FLAT
 * tonal icon chip (light tinted bg + a colored icon) and the thin left accent
 * bar. The card surface itself is the neutral token bg-card — color stays a
 * quiet accent rather than a saturated gradient wall (calm enterprise intent).
 *
 * Tailwind needs full literal class names at build time, which is why we
 * spell them out here instead of templating.
 */
type ColorTheme = {
  iconBg: string     // flat tonal background behind the icon
  iconText: string   // icon colour
  accent: string     // left accent bar colour
}

const THEMES: Record<string, ColorTheme> = {
  // Icon text is the -700 shade (not -600) so the glyph clears the 3:1
  // graphical-contrast floor on its -50 tonal chip for every hue (yellow/amber
  // -600 failed). -700 on -50 passes with margin across the palette.
  teal:    { iconBg: 'bg-teal-50',    iconText: 'text-teal-700',    accent: 'bg-teal-500' },
  blue:    { iconBg: 'bg-blue-50',    iconText: 'text-blue-700',    accent: 'bg-blue-500' },
  green:   { iconBg: 'bg-green-50',   iconText: 'text-green-700',   accent: 'bg-green-500' },
  emerald: { iconBg: 'bg-emerald-50', iconText: 'text-emerald-700', accent: 'bg-emerald-500' },
  red:     { iconBg: 'bg-red-50',     iconText: 'text-red-700',     accent: 'bg-red-500' },
  yellow:  { iconBg: 'bg-yellow-50',  iconText: 'text-yellow-700',  accent: 'bg-yellow-500' },
  amber:   { iconBg: 'bg-amber-50',   iconText: 'text-amber-700',   accent: 'bg-amber-500' },
  orange:  { iconBg: 'bg-orange-50',  iconText: 'text-orange-700',  accent: 'bg-orange-500' },
  purple:  { iconBg: 'bg-purple-50',  iconText: 'text-purple-700',  accent: 'bg-purple-500' },
  pink:    { iconBg: 'bg-pink-50',    iconText: 'text-pink-700',    accent: 'bg-pink-500' },
  indigo:  { iconBg: 'bg-indigo-50',  iconText: 'text-indigo-700',  accent: 'bg-indigo-500' },
  cyan:    { iconBg: 'bg-cyan-50',    iconText: 'text-cyan-700',    accent: 'bg-cyan-500' },
  gray:    { iconBg: 'bg-zinc-100',   iconText: 'text-zinc-700',    accent: 'bg-zinc-400' },
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
  iconBg: 'bg-red-50',
  iconText: 'text-red-600',
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
        : 'bg-muted text-zinc-600 ring-1 ring-border'

  const Wrapper = clickable ? 'button' : 'div'

  return (
    <Wrapper
      onClick={onClick}
      type={clickable ? 'button' : undefined}
      className={cn(
        'group relative w-full overflow-hidden rounded-xl border bg-card p-5 shadow-sm text-left',
        'ring-1 transition-all duration-200 hover:shadow-md',
        clickable && 'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--brand-accent)]',
        alert ? 'border-red-200' : 'border-border',
        active ? `ring-2 shadow-md ${theme.accent.replace('bg-', 'ring-')}` : 'ring-transparent',
      )}
    >
      {/* Left accent bar — thin + rounded, the card's quiet color cue */}
      <div
        className={cn(
          'absolute left-0 top-3 bottom-3 w-1 rounded-r-full',
          theme.accent,
        )}
      />

      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
          <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums text-foreground">
            {value}
          </p>
          {subtitle && (
            <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
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
            'relative flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl',
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
