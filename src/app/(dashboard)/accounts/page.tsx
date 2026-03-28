'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Clock, MessageCircle, AlertCircle, Loader2 } from 'lucide-react'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { PhaseIndicator } from '@/components/ui/phase-indicator'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase-client'
import { cn, timeAgo, getChannelLabel } from '@/lib/utils'
import type { Account } from '@/types/database'
import { useUser } from '@/context/user-context'

interface AccountWithStats extends Account {
  totalMessages: number
  pendingReplies: number
  lastMessageAt: string | null
}

export default function AccountsPage() {
  const { isAdmin, account_id: userAccountId } = useUser()
  const [accounts, setAccounts] = useState<AccountWithStats[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchAccounts() {
      const supabase = createClient()

      // Fetch accounts - non-admins only see their company
      let accountsQuery = supabase
        .from('accounts')
        .select('*')
        .order('name')
      if (!isAdmin && userAccountId) {
        accountsQuery = accountsQuery.eq('id', userAccountId)
      }
      const { data: accountRows, error } = await accountsQuery

      if (error || !accountRows) {
        console.error('Error fetching accounts:', error)
        setLoading(false)
        return
      }

      // For each account, fetch message count, pending reply count, and last message time
      const accountIds = accountRows.map((a: Account) => a.id)

      // Fetch total message counts per account
      const { data: messageCounts, error: messageCountsError } = await supabase
        .from('messages')
        .select('account_id')
        .in('account_id', accountIds)

      if (messageCountsError) {
        console.error('Error fetching message counts:', messageCountsError)
      }

      // Fetch pending replies (reply_required = true AND replied = false)
      const { data: pendingRows, error: pendingError } = await supabase
        .from('messages')
        .select('account_id')
        .in('account_id', accountIds)
        .eq('reply_required', true)
        .eq('replied', false)

      if (pendingError) {
        console.error('Error fetching pending replies:', pendingError)
      }

      // Fetch latest message time per account from conversations
      const { data: latestConvos, error: latestConvosError } = await supabase
        .from('conversations')
        .select('account_id, last_message_at')
        .in('account_id', accountIds)
        .order('last_message_at', { ascending: false })

      if (latestConvosError) {
        console.error('Error fetching latest conversations:', latestConvosError)
      }

      // Build count maps
      const totalMap = new Map<string, number>()
      const pendingMap = new Map<string, number>()
      const lastMsgMap = new Map<string, string>()

      ;(messageCounts || []).forEach((m: { account_id: string }) => {
        totalMap.set(m.account_id, (totalMap.get(m.account_id) || 0) + 1)
      })

      ;(pendingRows || []).forEach((m: { account_id: string }) => {
        pendingMap.set(m.account_id, (pendingMap.get(m.account_id) || 0) + 1)
      })

      ;(latestConvos || []).forEach((c: { account_id: string; last_message_at: string | null }) => {
        if (!lastMsgMap.has(c.account_id) && c.last_message_at) {
          lastMsgMap.set(c.account_id, c.last_message_at)
        }
      })

      const enriched: AccountWithStats[] = accountRows.map((a: Account) => ({
        ...a,
        totalMessages: totalMap.get(a.id) || 0,
        pendingReplies: pendingMap.get(a.id) || 0,
        lastMessageAt: lastMsgMap.get(a.id) || null,
      }))

      setAccounts(enriched)
      setLoading(false)
    }

    fetchAccounts()
  }, [isAdmin, userAccountId])

  if (loading) {
    return (
      <div className="flex h-80 items-center justify-center animate-fade-in">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-xl bg-teal-100 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-teal-600" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-gray-700">Loading accounts</p>
            <p className="text-xs text-gray-400 mt-1">Fetching account data...</p>
          </div>
        </div>
      </div>
    )
  }

  const activeAccounts = accounts.filter(a => a.is_active)
  const inactiveAccounts = accounts.filter(a => !a.is_active)
  const totalPending = accounts.reduce((sum, a) => sum + a.pendingReplies, 0)
  const phase2Count = accounts.filter(a => a.phase2_enabled).length

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Accounts</h1>
          <p className="mt-1 text-sm text-gray-500">
            {activeAccounts.length} active, {inactiveAccounts.length} inactive accounts across channels
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="success" size="md">{activeAccounts.length} Active</Badge>
          <Badge variant="default" size="md">{inactiveAccounts.length} Inactive</Badge>
        </div>
      </div>

      {/* Stats summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm hover:shadow-md transition-shadow">
          <p className="text-sm text-gray-500">Total Accounts</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{accounts.length}</p>
          <div className="mt-2 h-1 w-full rounded-full bg-gray-100">
            <div className="h-1 rounded-full bg-teal-500 transition-all" style={{ width: `${(activeAccounts.length / Math.max(accounts.length, 1)) * 100}%` }} />
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm hover:shadow-md transition-shadow">
          <p className="text-sm text-gray-500">Active with Phase 2</p>
          <p className="mt-1 text-2xl font-bold text-teal-700">{phase2Count}</p>
          <p className="mt-1 text-xs text-gray-400">AI auto-reply enabled</p>
        </div>
        <div className={cn("rounded-xl border bg-white px-5 py-4 shadow-sm hover:shadow-md transition-shadow", totalPending > 0 ? "border-orange-200" : "border-gray-200")}>
          <p className="text-sm text-gray-500">Pending Replies</p>
          <p className={cn("mt-1 text-2xl font-bold", totalPending > 0 ? "text-orange-600" : "text-gray-900")}>{totalPending}</p>
          {totalPending > 0 && <p className="mt-1 text-xs text-orange-500">Needs attention</p>}
        </div>
      </div>

      {/* Account grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {activeAccounts.map(account => (
          <Link
            key={account.id}
            href={`/accounts/${account.id}`}
            className="group block rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-all hover:border-teal-300 hover:shadow-md hover:-translate-y-0.5"
          >
            {/* Top row: channel icon + name + phase */}
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-50">
                  <ChannelIcon channel={account.channel_type} size={22} />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 group-hover:text-teal-700 transition-colors">
                    {account.name}
                  </h3>
                  <p className="text-xs text-gray-500">{getChannelLabel(account.channel_type)}</p>
                </div>
              </div>
              <PhaseIndicator
                phase1_enabled={account.phase1_enabled}
                phase2_enabled={account.phase2_enabled}
                className="text-xs"
              />
            </div>

            {/* Message stats */}
            <div className="mt-4 flex items-center gap-4">
              <div className="flex items-center gap-1.5 text-sm text-gray-600">
                <MessageCircle size={14} />
                <span>{account.totalMessages} total</span>
              </div>
              <div
                className={cn(
                  'flex items-center gap-1.5 text-sm',
                  account.pendingReplies > 0 ? 'text-orange-600' : 'text-gray-400'
                )}
              >
                <AlertCircle size={14} />
                <span>{account.pendingReplies} pending</span>
              </div>
            </div>

            {/* Last activity */}
            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-gray-400">
                <Clock size={12} />
                <span>{account.lastMessageAt ? `Active ${timeAgo(account.lastMessageAt)} ago` : 'No messages yet'}</span>
              </div>
              {!account.is_active && (
                <Badge variant="default" size="sm">Inactive</Badge>
              )}
            </div>
          </Link>
        ))}
      </div>

      {/* Inactive accounts section */}
      {inactiveAccounts.length > 0 && (
        <div className="animate-slide-up stagger-3">
          <h2 className="text-lg font-semibold text-gray-700 mb-3">Inactive Accounts ({inactiveAccounts.length})</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {inactiveAccounts.map(account => (
              <Link
                key={account.id}
                href={`/accounts/${account.id}`}
                className="group flex items-center gap-3 rounded-lg border border-gray-100 bg-gray-50/50 px-4 py-3 transition-all hover:bg-white hover:border-gray-200 hover:shadow-sm"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100">
                  <ChannelIcon channel={account.channel_type} size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-600 truncate group-hover:text-gray-900 transition-colors">{account.name}</p>
                  <p className="text-xs text-gray-400">{getChannelLabel(account.channel_type)}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
