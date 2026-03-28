import { cn } from '@/lib/utils'

const variantStyles = {
  default: 'bg-gray-100 text-gray-700',
  success: 'bg-green-100 text-green-700',
  warning: 'bg-yellow-100 text-yellow-700',
  danger: 'bg-red-100 text-red-700',
  info: 'bg-blue-100 text-blue-700',
  teams: 'bg-purple-100 text-purple-700',
  email: 'bg-red-100 text-red-600',
  whatsapp: 'bg-green-100 text-green-600',
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
