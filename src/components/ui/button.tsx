'use client'

import React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// `primary` routes through --brand-accent (which defaults to teal-700, so the
// unbranded look is unchanged) so per-company branding actually reaches buttons
// app-wide. Per-variant focus rings are intentionally omitted — the global
// `button:focus-visible` rule in globals.css owns focus (one teal ring, not a
// stacked pair). Neutrals are zinc (matches the theme tokens), not gray.
const variantStyles = {
  primary:
    'bg-[var(--brand-accent)] text-white hover:brightness-110 disabled:opacity-50',
  secondary:
    'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 disabled:bg-zinc-50 disabled:text-zinc-400',
  danger:
    'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
  ghost:
    'bg-transparent text-zinc-700 hover:bg-zinc-100 disabled:text-zinc-400',
  success:
    'bg-green-600 text-white hover:bg-green-700 disabled:bg-green-300',
} as const

const sizeStyles = {
  sm: 'px-3 py-1.5 text-sm gap-1.5',
  md: 'px-4 py-2 text-sm gap-2',
  lg: 'px-6 py-3 text-base gap-2',
  // Square size for icon-only buttons (~36px hit area) — replaces the
  // hand-rolled small icon buttons on modal/toast/pagination/shortcut closes.
  icon: 'h-9 w-9 p-0',
} as const

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variantStyles
  size?: keyof typeof sizeStyles
  loading?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      disabled,
      className,
      children,
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          'inline-flex items-center justify-center rounded-[var(--radius)] font-medium transition-colors disabled:cursor-not-allowed',
          variantStyles[variant],
          sizeStyles[size],
          className
        )}
        {...props}
      >
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'
