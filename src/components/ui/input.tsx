import React from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  icon?: React.ReactNode
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, icon, className, id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-')

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="mb-1.5 block text-sm font-medium text-zinc-700"
          >
            {label}
          </label>
        )}
        <div className="relative">
          {icon && (
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
              {icon}
            </div>
          )}
          <input
            ref={ref}
            id={inputId}
            className={cn(
              'block w-full rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm text-foreground placeholder-gray-400 transition-colors',
              'focus:border-[var(--brand-accent)] focus:outline-none',
              'disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-muted-foreground',
              error && 'border-[var(--color-danger)] focus:border-[var(--color-danger)]',
              icon && 'pl-10',
              className
            )}
            {...props}
          />
        </div>
        {error && <p className="mt-1.5 text-sm text-[var(--color-danger)]">{error}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'
