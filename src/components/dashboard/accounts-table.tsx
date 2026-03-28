'use client'

import Link from 'next/link'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { PhaseIndicator } from '@/components/ui/phase-indicator'
import { Badge } from '@/components/ui/badge'
import { timeAgo } from '@/lib/utils'
import type { AccountOverview } from '@/types/database'
import type { ChannelFilterValue } from './channel-filter'

interface AccountsTableProps {
  accounts: AccountOverview[]
  filter: ChannelFilterValue
}

export function AccountsTable({ accounts, filter }: AccountsTableProps) {
  const filtered =
    filter === 'all'
      ? accounts
      : accounts.filter((a) => a.channel_type === filter)

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Channel</TableHead>
          <TableHead>Account Name</TableHead>
          <TableHead>Phase Status</TableHead>
          <TableHead className="text-center">Pending</TableHead>
          <TableHead>Last Message</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {filtered.map((account) => (
          <TableRow key={account.id}>
            <TableCell>
              <Link
                href={`/accounts/${account.id}`}
                className="flex items-center gap-2"
              >
                <ChannelIcon channel={account.channel_type} size={18} />
              </Link>
            </TableCell>
            <TableCell>
              <Link
                href={`/accounts/${account.id}`}
                className="font-medium text-gray-900 hover:text-teal-600 transition-colors"
              >
                {account.name}
              </Link>
            </TableCell>
            <TableCell>
              <PhaseIndicator
                phase1_enabled={account.phase1_enabled}
                phase2_enabled={account.phase2_enabled}
              />
            </TableCell>
            <TableCell className="text-center">
              {account.pendingCount > 0 ? (
                <Badge variant={account.pendingCount >= 4 ? 'danger' : 'warning'} size="sm">
                  {account.pendingCount}
                </Badge>
              ) : (
                <span className="text-gray-400">0</span>
              )}
            </TableCell>
            <TableCell>
              <span className="text-sm text-gray-500">
                {account.lastMessageTime
                  ? `${timeAgo(account.lastMessageTime)} ago`
                  : 'No messages yet'}
              </span>
            </TableCell>
          </TableRow>
        ))}
        {filtered.length === 0 && (
          <TableRow>
            <TableCell colSpan={5} className="py-8 text-center text-gray-400">
              No accounts match the selected filter.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}
