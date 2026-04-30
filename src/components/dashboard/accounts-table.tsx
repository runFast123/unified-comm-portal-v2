'use client'

import { useState, Fragment } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, ExternalLink, MessageCircle, Clock } from 'lucide-react'
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

function getBaseName(name: string): string {
  return name.replace(/\s+Teams$/i, '').trim()
}

interface GroupedAccount {
  baseName: string
  email: AccountOverview | null
  teams: AccountOverview | null
  totalPending: number
  lastMessageTime: string | null
}

export function AccountsTable({ accounts, filter }: AccountsTableProps) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null)

  const filtered =
    filter === 'all'
      ? accounts
      : accounts.filter((a) => a.channel_type === filter)

  // Group by company name
  const groupMap = new Map<string, GroupedAccount>()
  for (const acc of filtered) {
    const baseName = getBaseName(acc.name)
    const existing = groupMap.get(baseName) || {
      baseName,
      email: null,
      teams: null,
      totalPending: 0,
      lastMessageTime: null,
    }

    if (acc.channel_type === 'email') existing.email = acc
    else if (acc.channel_type === 'teams') existing.teams = acc

    existing.totalPending += acc.pendingCount
    if (acc.lastMessageTime) {
      if (!existing.lastMessageTime || acc.lastMessageTime > existing.lastMessageTime) {
        existing.lastMessageTime = acc.lastMessageTime
      }
    }

    groupMap.set(baseName, existing)
  }

  const groups = Array.from(groupMap.values()).sort((a, b) => a.baseName.localeCompare(b.baseName))

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>Company</TableHead>
          <TableHead className="hidden md:table-cell">Channels</TableHead>
          <TableHead className="hidden lg:table-cell">Phase Status</TableHead>
          <TableHead className="text-center">Pending</TableHead>
          <TableHead className="hidden sm:table-cell">Last Message</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => {
          const primary = group.email || group.teams
          if (!primary) return null
          const isExpanded = expandedRow === group.baseName
          return (
            <Fragment key={group.baseName}>
              <TableRow
                className="cursor-pointer hover:bg-gray-50 transition-colors"
                onClick={() => setExpandedRow(isExpanded ? null : group.baseName)}
              >
                <TableCell className="w-8 pr-0">
                  {isExpanded
                    ? <ChevronDown className="h-4 w-4 text-gray-400" />
                    : <ChevronRight className="h-4 w-4 text-gray-400" />}
                </TableCell>
                <TableCell>
                  <span className="font-medium text-gray-900">{group.baseName}</span>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <div className="flex items-center gap-1.5">
                    {group.email && (
                      <span className="flex items-center gap-1 rounded-md bg-red-50 px-2 py-0.5 text-xs text-red-700" title="Email">
                        <ChannelIcon channel="email" size={12} /> Email
                      </span>
                    )}
                    {group.teams && (
                      <span className="flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700" title="Teams">
                        <ChannelIcon channel="teams" size={12} /> Teams
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <PhaseIndicator
                    phase1_enabled={primary.phase1_enabled}
                    phase2_enabled={primary.phase2_enabled}
                  />
                </TableCell>
                <TableCell className="text-center">
                  {group.totalPending > 0 ? (
                    <Badge variant={group.totalPending >= 4 ? 'danger' : 'warning'} size="sm">
                      {group.totalPending}
                    </Badge>
                  ) : (
                    <span className="text-gray-400">0</span>
                  )}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <span className="text-sm text-gray-500">
                    {group.lastMessageTime
                      ? `${timeAgo(group.lastMessageTime)} ago`
                      : 'No messages yet'}
                  </span>
                </TableCell>
              </TableRow>

              {/* Expanded detail row */}
              {isExpanded && (
                <TableRow key={`${group.baseName}-detail`} className="bg-gray-50/50">
                  <TableCell />
                  {/* Span all remaining columns at every breakpoint */}
                  <TableCell colSpan={5}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-1">
                      {group.email && (
                        <Link
                          href={`/accounts/${group.email.id}`}
                          className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-teal-300 hover:shadow-sm transition-all group"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-50">
                            <ChannelIcon channel="email" size={18} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 group-hover:text-teal-700">Email Channel</p>
                            <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
                              <span className="flex items-center gap-1"><MessageCircle size={10} /> {group.email.pendingCount} pending</span>
                              <span className="flex items-center gap-1"><Clock size={10} /> {group.email.lastMessageTime ? timeAgo(group.email.lastMessageTime) : 'No activity'}</span>
                            </div>
                          </div>
                          <ExternalLink className="h-3.5 w-3.5 text-gray-300 group-hover:text-teal-500" />
                        </Link>
                      )}
                      {group.teams && (
                        <Link
                          href={`/accounts/${group.teams.id}`}
                          className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-teal-300 hover:shadow-sm transition-all group"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50">
                            <ChannelIcon channel="teams" size={18} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 group-hover:text-teal-700">Teams Channel</p>
                            <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
                              <span className="flex items-center gap-1"><MessageCircle size={10} /> {group.teams.pendingCount} pending</span>
                              <span className="flex items-center gap-1"><Clock size={10} /> {group.teams.lastMessageTime ? timeAgo(group.teams.lastMessageTime) : 'No activity'}</span>
                            </div>
                          </div>
                          <ExternalLink className="h-3.5 w-3.5 text-gray-300 group-hover:text-teal-500" />
                        </Link>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          )
        })}
        {groups.length === 0 && (
          <TableRow>
            <TableCell colSpan={6} className="py-8 text-center text-gray-400">
              No accounts match the selected filter.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}
