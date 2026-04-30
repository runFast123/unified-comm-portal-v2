'use client'

import { useState, useEffect, useCallback, Fragment } from 'react'
import Link from 'next/link'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { getChannelLabel, timeAgo } from '@/lib/utils'
import { createClient } from '@/lib/supabase-client'
import type { ChannelType } from '@/types/database'
import { ArrowUpDown, ChevronUp, ChevronDown, ChevronRight, Calendar, X, Loader2, ExternalLink } from 'lucide-react'

export interface CompanyPerformance {
  id: string
  name: string
  channel_type: ChannelType
  gmail_address: string | null
  totalMessages: number
  pendingReplies: number
  aiDraftsReady: number
  aiRepliesSent: number
  responseRate: number
  topCategory: string | null
  lastActivity: string | null
}

type SortKey = 'name' | 'totalMessages' | 'pendingReplies' | 'aiDraftsReady' | 'aiRepliesSent' | 'responseRate' | 'lastActivity'

interface Props {
  stats: CompanyPerformance[]
  companyAccountIds?: string[]
}

export function CompanyStatsTable({ stats, companyAccountIds }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('totalMessages')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [specificDate, setSpecificDate] = useState('')
  const [dateFilteredStats, setDateFilteredStats] = useState<CompanyPerformance[] | null>(null)
  const [dateLoading, setDateLoading] = useState(false)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)

  // Fetch per-account stats for a specific date
  const fetchForDate = useCallback(async (date: string) => {
    if (!date) { setDateFilteredStats(null); return }
    setDateLoading(true)
    const supabase = createClient()
    const startOfDay = new Date(date + 'T00:00:00').toISOString()
    const endOfDay = new Date(date + 'T23:59:59.999').toISOString()

    // Get accounts (scoped for non-admin users)
    let accQuery = supabase
      .from('accounts')
      .select('id, name, channel_type, gmail_address')
      .eq('is_active', true)
      .order('name')
    if (companyAccountIds && companyAccountIds.length > 0) {
      accQuery = accQuery.in('id', companyAccountIds)
    }
    const { data: accounts } = await accQuery

    if (!accounts) { setDateLoading(false); return }

    const results: CompanyPerformance[] = await Promise.all(
      accounts.map(async (acc) => {
        const [totalRes, pendingRes, aiSentRes, aiDraftsRes, classRes] = await Promise.all([
          supabase.from('messages').select('*', { count: 'exact', head: true })
            .eq('account_id', acc.id).eq('direction', 'inbound')
            .gte('received_at', startOfDay).lte('received_at', endOfDay),
          supabase.from('messages').select('*', { count: 'exact', head: true })
            .eq('account_id', acc.id).eq('direction', 'inbound')
            .eq('reply_required', true).eq('replied', false)
            .gte('received_at', startOfDay).lte('received_at', endOfDay),
          supabase.from('ai_replies').select('*', { count: 'exact', head: true })
            .eq('account_id', acc.id).eq('status', 'sent')
            .gte('created_at', startOfDay).lte('created_at', endOfDay),
          supabase.from('ai_replies').select('*', { count: 'exact', head: true })
            .eq('account_id', acc.id).in('status', ['pending_approval', 'edited'])
            .gte('created_at', startOfDay).lte('created_at', endOfDay),
          supabase.from('message_classifications')
            .select('category, messages!inner(account_id)')
            .eq('messages.account_id', acc.id)
            .gte('classified_at', startOfDay).lte('classified_at', endOfDay)
            .limit(200),
        ])
        const total = totalRes.count || 0
        const pending = pendingRes.count || 0
        const aiSent = aiSentRes.count || 0
        const aiDrafts = aiDraftsRes.count || 0
        const catCounts: Record<string, number> = {}
        ;(classRes.data || []).forEach((c: { category: string }) => {
          catCounts[c.category] = (catCounts[c.category] || 0) + 1
        })
        const topCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0]

        return {
          id: acc.id,
          name: acc.name,
          channel_type: acc.channel_type as ChannelType,
          gmail_address: acc.gmail_address as string | null,
          totalMessages: total,
          pendingReplies: pending,
          aiDraftsReady: aiDrafts,
          aiRepliesSent: aiSent,
          responseRate: total > 0 ? Math.round((aiSent / total) * 100) : 0,
          topCategory: topCat ? topCat[0] : null,
          lastActivity: null, // Not relevant for specific date view
        }
      })
    )
    setDateFilteredStats(results)
    setDateLoading(false)
  }, [])

  useEffect(() => {
    if (specificDate) fetchForDate(specificDate)
    else setDateFilteredStats(null)
  }, [specificDate, fetchForDate])

  const rawStats = dateFilteredStats || stats

  // Group by base company name (merge "Acepeak" + "Acepeak Teams" into one row)
  const groupMap = new Map<string, CompanyPerformance>()
  for (const s of rawStats) {
    const baseName = s.name.replace(/\s+Teams$/i, '').trim()
    const existing = groupMap.get(baseName)
    if (existing) {
      existing.totalMessages += s.totalMessages
      existing.pendingReplies += s.pendingReplies
      existing.aiDraftsReady += s.aiDraftsReady
      existing.aiRepliesSent += s.aiRepliesSent
      existing.responseRate = existing.totalMessages > 0
        ? Math.round((existing.aiRepliesSent / existing.totalMessages) * 100)
        : 0
      if (!existing.topCategory && s.topCategory) existing.topCategory = s.topCategory
      if (s.lastActivity && (!existing.lastActivity || s.lastActivity > existing.lastActivity)) {
        existing.lastActivity = s.lastActivity
      }
      if (!existing.gmail_address && s.gmail_address) existing.gmail_address = s.gmail_address
      // Track which channels exist
      ;(existing as any)._hasEmail = (existing as any)._hasEmail || s.channel_type === 'email'
      ;(existing as any)._hasTeams = (existing as any)._hasTeams || s.channel_type === 'teams'
    } else {
      const merged = { ...s, name: baseName }
      ;(merged as any)._hasEmail = s.channel_type === 'email'
      ;(merged as any)._hasTeams = s.channel_type === 'teams'
      groupMap.set(baseName, merged)
    }
  }
  const displayStats = Array.from(groupMap.values())

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sorted = [...displayStats].sort((a, b) => {
    let cmp = 0
    switch (sortKey) {
      case 'name': cmp = a.name.localeCompare(b.name); break
      case 'totalMessages': cmp = a.totalMessages - b.totalMessages; break
      case 'pendingReplies': cmp = a.pendingReplies - b.pendingReplies; break
      case 'aiDraftsReady': cmp = a.aiDraftsReady - b.aiDraftsReady; break
      case 'aiRepliesSent': cmp = a.aiRepliesSent - b.aiRepliesSent; break
      case 'responseRate': cmp = a.responseRate - b.responseRate; break
      case 'lastActivity':
        cmp = (a.lastActivity || '').localeCompare(b.lastActivity || '')
        break
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 text-gray-300" />
    return sortDir === 'asc'
      ? <ChevronUp className="h-3 w-3 text-teal-600" />
      : <ChevronDown className="h-3 w-3 text-teal-600" />
  }

  const SortableHead = ({ col, children }: { col: SortKey; children: React.ReactNode }) => (
    <TableHead>
      <button
        onClick={() => toggleSort(col)}
        className="inline-flex items-center gap-1 hover:text-teal-700 transition-colors"
      >
        {children}
        <SortIcon col={col} />
      </button>
    </TableHead>
  )

  const getRateColor = (rate: number) => {
    if (rate >= 50) return 'text-green-600'
    if (rate >= 20) return 'text-amber-600'
    return 'text-red-600'
  }

  if (displayStats.length === 0 && !dateLoading) {
    return (
      <div>
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5">
            <Calendar className="h-3.5 w-3.5 text-gray-400" />
            <input
              type="date"
              value={specificDate}
              onChange={(e) => setSpecificDate(e.target.value)}
              className="bg-transparent text-sm text-gray-700 focus:outline-none"
            />
            {specificDate && (
              <button onClick={() => setSpecificDate('')} className="text-gray-400 hover:text-gray-600">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {specificDate && <span className="text-xs text-teal-600 font-medium">Showing data for {specificDate}</span>}
        </div>
        <div className="py-8 text-center text-sm text-gray-400">
          No company data available for this period.
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Day-wise filter */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5">
          <Calendar className="h-3.5 w-3.5 text-gray-400" />
          <input
            type="date"
            value={specificDate}
            onChange={(e) => setSpecificDate(e.target.value)}
            className="bg-transparent text-sm text-gray-700 focus:outline-none"
          />
          {specificDate && (
            <button onClick={() => setSpecificDate('')} className="text-gray-400 hover:text-gray-600">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {specificDate && <span className="text-xs text-teal-600 font-medium">Showing data for {specificDate}</span>}
        {!specificDate && <span className="text-xs text-gray-400">Pick a date to filter by specific day</span>}
        {dateLoading && <Loader2 className="h-4 w-4 animate-spin text-teal-600" />}
      </div>

    <Table>
      <TableHeader>
        <TableRow>
          <SortableHead col="name">Company</SortableHead>
          <TableHead className="hidden md:table-cell">Channels</TableHead>
          <SortableHead col="totalMessages">Messages</SortableHead>
          <SortableHead col="pendingReplies">Pending</SortableHead>
          <TableHead className="hidden lg:table-cell">
            <button onClick={() => toggleSort('aiDraftsReady')} className="inline-flex items-center gap-1 hover:text-teal-700 transition-colors">
              AI Drafts
              <SortIcon col="aiDraftsReady" />
            </button>
          </TableHead>
          <TableHead className="hidden lg:table-cell">
            <button onClick={() => toggleSort('aiRepliesSent')} className="inline-flex items-center gap-1 hover:text-teal-700 transition-colors">
              AI Sent
              <SortIcon col="aiRepliesSent" />
            </button>
          </TableHead>
          <TableHead className="hidden md:table-cell">
            <button onClick={() => toggleSort('responseRate')} className="inline-flex items-center gap-1 hover:text-teal-700 transition-colors">
              Response Rate
              <SortIcon col="responseRate" />
            </button>
          </TableHead>
          <TableHead className="hidden xl:table-cell">Top Category</TableHead>
          <TableHead className="hidden sm:table-cell">
            <button onClick={() => toggleSort('lastActivity')} className="inline-flex items-center gap-1 hover:text-teal-700 transition-colors">
              Last Active
              <SortIcon col="lastActivity" />
            </button>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((s) => {
          const isExpanded = expandedRow === s.name
          return (
            <Fragment key={s.id}>
              <TableRow
                className="cursor-pointer hover:bg-gray-50 transition-colors"
                onClick={() => setExpandedRow(isExpanded ? null : s.name)}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    {isExpanded
                      ? <ChevronDown className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                      : <ChevronRight className="h-3.5 w-3.5 text-gray-400 shrink-0" />}
                    <div>
                      <span className="font-medium text-gray-900">{s.name}</span>
                      {s.gmail_address && (
                        <span className="text-xs text-gray-400 truncate max-w-[160px] block mt-0.5">{s.gmail_address}</span>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <div className="flex items-center gap-1.5">
                    {(s as any)._hasEmail && (
                      <span className="flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-600">
                        <ChannelIcon channel="email" size={10} /> Email
                      </span>
                    )}
                    {(s as any)._hasTeams && (
                      <span className="flex items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600">
                        <ChannelIcon channel="teams" size={10} /> Teams
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <span className="font-semibold text-gray-900">{s.totalMessages}</span>
                </TableCell>
                <TableCell>
                  <span className={`font-semibold ${s.pendingReplies > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                    {s.pendingReplies}
                  </span>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <span className={`font-semibold ${s.aiDraftsReady > 0 ? 'text-purple-600' : 'text-gray-400'}`}>{s.aiDraftsReady}</span>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <span className="font-semibold text-teal-700">{s.aiRepliesSent}</span>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <span className={`font-semibold ${getRateColor(s.responseRate)}`}>
                    {s.responseRate}%
                  </span>
                </TableCell>
                <TableCell className="hidden xl:table-cell">
                  {s.topCategory ? (
                    <Badge variant="default" size="sm">{s.topCategory}</Badge>
                  ) : (
                    <span className="text-xs text-gray-300">--</span>
                  )}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <span className="text-sm text-gray-500">
                    {s.lastActivity ? timeAgo(s.lastActivity) : '--'}
                  </span>
                </TableCell>
              </TableRow>

              {/* Expanded row with channel links */}
              {isExpanded && (
                <TableRow key={`${s.id}-expanded`} className="bg-gray-50/50">
                  <TableCell colSpan={9}>
                    <div className="flex items-center gap-3 py-1 pl-6">
                      {(s as any)._hasEmail && (
                        <Link
                          href={`/inbox?channel=email`}
                          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm hover:border-teal-300 hover:shadow-sm transition-all group"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ChannelIcon channel="email" size={14} />
                          <span className="font-medium text-gray-700 group-hover:text-teal-700">View Email Inbox</span>
                          <ExternalLink className="h-3 w-3 text-gray-300 group-hover:text-teal-500" />
                        </Link>
                      )}
                      {(s as any)._hasTeams && (
                        <Link
                          href={`/inbox?channel=teams`}
                          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm hover:border-teal-300 hover:shadow-sm transition-all group"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ChannelIcon channel="teams" size={14} />
                          <span className="font-medium text-gray-700 group-hover:text-teal-700">View Teams Inbox</span>
                          <ExternalLink className="h-3 w-3 text-gray-300 group-hover:text-teal-500" />
                        </Link>
                      )}
                      <Link
                        href={`/accounts/${s.id}`}
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm hover:border-teal-300 hover:shadow-sm transition-all group"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="font-medium text-gray-700 group-hover:text-teal-700">Account Details</span>
                        <ExternalLink className="h-3 w-3 text-gray-300 group-hover:text-teal-500" />
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          )
        })}
      </TableBody>
    </Table>
    </div>
  )
}
