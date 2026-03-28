import { cn } from '@/lib/utils'

interface ReportCardProps {
  title: string
  description?: string
  children: React.ReactNode
  className?: string
}

export function ReportCard({ title, description, children, className }: ReportCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-gray-200 bg-white shadow-sm',
        className
      )}
    >
      <div className="border-b border-gray-100 px-6 py-4">
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        {description && (
          <p className="mt-1 text-sm text-gray-500">{description}</p>
        )}
      </div>
      <div className="px-6 py-4">{children}</div>
    </div>
  )
}
