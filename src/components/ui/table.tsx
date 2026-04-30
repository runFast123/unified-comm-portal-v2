import { cn } from '@/lib/utils'

export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  children: React.ReactNode
}

export function Table({ className, children, ...props }: TableProps) {
  return (
    <div className="w-full overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <table
        className={cn('w-full min-w-[640px] text-left text-sm', className)}
        {...props}
      >
        {children}
      </table>
    </div>
  )
}

export function TableHeader({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('border-b border-gray-200 bg-gray-50', className)}
      {...props}
    >
      {children}
    </thead>
  )
}

export function TableBody({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cn('divide-y divide-gray-100', className)} {...props}>
      {children}
    </tbody>
  )
}

export function TableRow({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn('transition-colors hover:bg-gray-50', className)}
      {...props}
    >
      {children}
    </tr>
  )
}

export function TableHead({
  className,
  children,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500',
        className
      )}
      {...props}
    >
      {children}
    </th>
  )
}

export function TableCell({
  className,
  children,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('px-4 py-3 text-gray-700', className)} {...props}>
      {children}
    </td>
  )
}
