import { cn } from '@/lib/utils'

export interface CardProps {
  title?: string
  description?: string
  footer?: React.ReactNode
  className?: string
  children: React.ReactNode
}

export function Card({ title, description, footer, className, children }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card text-card-foreground shadow-sm',
        className
      )}
    >
      {(title || description) && (
        <div className="border-b border-border px-6 py-4">
          {title && <h3 className="text-lg font-semibold text-foreground">{title}</h3>}
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      )}
      <div className="px-6 py-4">{children}</div>
      {footer && (
        <div className="border-t border-border px-6 py-3">{footer}</div>
      )}
    </div>
  )
}
