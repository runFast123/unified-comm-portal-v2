'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { getChannelLabel, timeAgo } from '@/lib/utils'
import { createClient } from '@/lib/supabase-client'
import type { ChannelType } from '@/types/database'
import { ArrowUpDown, ChevronUp, ChevronDown, Calendar, X, Loader2 } from 'lucide-react'

export interface CompanyPerformance {
  id: string
  name: string
  channel_type: ChannelType
  gmail_address: string | null
  totalMessages: number
  pendingReplies: number
  aiRepliesSent: number
  responseRate: number
  topCategory: string | null
  lastActivity: string | null
}

type SortKey = 'name' | 'totalMessages' | 'pendingReplies' | 'aiRepliesSent' | 'responseRate' | 'lastActivity'

interface Props {
  stats: CompanyPerformance[]
}

export function CompanyStatsTable({ stats }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('totalMessages')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [specificDate, setSpecificDate] = useState('')
  const [dateFilteredStats, setDateFilteredStats] = useState<CompanyPerformance[] | null>(null)
  const [dateLoading, setDateLoading] = useState(false)

  // Fetch per-account stats for a specific date
  const fetchForDate = useCallback(async (date: string) => {
    if (!date) { setDateFilteredStats(null); return }
    setDateLoading(true)
    const supabase = createClient()
    const startOfDay = new Date(date + 'T00:00:00').toISOString()
    const endOfDay = new Date(date + 'T23:59:59.999').toISOString()

    // Get all accounts
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, name, channel_type, gmail_address')
      .eq('is_active', true)
      .order('name')

    if (!accounts) { setDateLoading(false); return }

    const results: CompanyPerformance[] = await Promise.all(
      accounts.map(async (acc) => {
        const [totalRes, pendingRes, aiSentRes, classRes] = await Promise.all([
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
          supabase.from('message_classifications')
            .select('category, messages!inner(account_id)')
            .eq('messages.account_id', acc.id)
            .gte('classified_at', startOfDay).lte('classified_at', endOfDay)
            .limit(200),
        ])
        const total = totalRes.count || 0
        const pending = pendingRes.count || 0
        const aiSent = aiSentRes.count || 0
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

  const displayStats = dateFilteredStats || stats

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
          <TableHead>Email</TableHead>
          <SortableHead col="totalMessages">Messages</SortableHead>
          <SortableHead col="pendingReplies">Pending</SortableHead>
          <SortableHead col="aiRepliesSent">AI Sent</SortableHead>
          <SortableHead col="responseRate">Response Rate</SortableHead>
          <TableHead>Top Category</TableHead>
          <SortableHead col="lastActivity">Last Active</SortableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((s) => (
          <TableRow key={s.id} className="cursor-pointer hover:bg-gray-50 transition-colors">
            <TableCell>
              <Link href={`/accounts/${s.id}`} className="flex items-center gap-2 font-medium text-gray-900 hover:text-teal-700">
                <ChannelIcon channel={s.channel_type} size={16} />
                {s.name}
              </Link>
            </TableCell>
            <TableCell>
              <span className="text-xs text-gray-500 truncate max-w-[160px] block">
                {s.gmail_address || <span className="text-gray-300 italic">--</span>}
              </span>
            </TableCell>
            <TableCell>
              <span className="font-semibold text-gray-900">{s.totalMessages}</span>
            </TableCell>
            <TableCell>
              <span className={`font-semibold ${s.pendingReplies > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                {s.pendingReplies}
              </span>
            </TableCell>
            <TableCell>
              <span className="font-semibold text-teal-700">{s.aiRepliesSent}</span>
            </TableCell>
            <TableCell>
              <span className={`font-semibold ${getRateColor(s.responseRate)}`}>
                {s.responseRate}%
              </span>
            </TableCell>
            <TableCell>
              {s.topCategory ? (
                <Badge variant="default" size="sm">{s.topCategory}</Badge>
              ) : (
                <span className="text-xs text-gray-300">--</span>
              )}
            </TableCell>
            <TableCell>
              <span className="text-sm text-gray-500">
                {s.lastActivity ? timeAgo(s.lastActivity) : '--'}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </div>
  )
}
