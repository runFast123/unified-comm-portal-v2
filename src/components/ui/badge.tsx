import { cn } from '@/lib/utils'

// Tint background carries the color identity; text is darkened to the -700/-800
// shade of the same family so badge labels clear WCAG 4.5:1 on the 10% tint
// (the raw -500 token shades failed — warning/whatsapp/success worst). teams
// (#6264a7) already passes at 4.73:1 so it keeps the exact brand token.
const variantStyles = {
  default: 'bg-muted text-zinc-700',
  success: 'bg-[var(--color-success)]/10 text-emerald-700',
  warning: 'bg-[var(--color-warning)]/10 text-amber-700',
  danger: 'bg-[var(--color-danger)]/10 text-red-700',
  info: 'bg-[var(--color-info)]/10 text-blue-700',
  teams: 'bg-[var(--color-teams)]/10 text-[var(--color-teams)]',
  email: 'bg-[var(--color-email)]/10 text-red-700',
  whatsapp: 'bg-[var(--color-whatsapp)]/10 text-emerald-800',
} as const

const sizeStyles = {
  sm: 'px-1.5 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-xs',
} as const

export interface BadgeProps {
  variant?: keyof typeof variantStyles
  size?: keyof typeof sizeStyles
  className?: string
  children: React.ReactNode
}

export function Badge({
  variant = 'default',
  size = 'md',
  className,
  children,
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-medium whitespace-nowrap',
        variantStyles[variant],
        sizeStyles[size],
        className
      )}
    >
      {children}
    </span>
  )
}
