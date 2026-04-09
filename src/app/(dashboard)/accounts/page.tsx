'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Clock, MessageCircle, AlertCircle, Loader2, Mail, MessageSquare } from 'lucide-react'
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

/** Group accounts by base company name (strips " Teams" suffix) */
interface CompanyGroup {
  baseName: string
  email: AccountWithStats | null
  teams: AccountWithStats | null
  totalMessages: number
  pendingReplies: number
  lastMessageAt: string | null
}

function getBaseName(accountName: string): string {
  return accountName.replace(/\s+Teams$/i, '').trim()
}

export default function AccountsPage() {
  const { isAdmin, companyAccountIds } = useUser()
  const [accounts, setAccounts] = useState<AccountWithStats[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchAccounts() {
      const supabase = createClient()

      let accountsQuery = supabase
        .from('accounts')
        .select('*')
        .order('name')
      if (!isAdmin && companyAccountIds.length > 0) {
        accountsQuery = accountsQuery.in('id', companyAccountIds)
      }
      const { data: accountRows, error } = await accountsQuery

      if (error || !accountRows) {
        console.error('Error fetching accounts:', error)
        setLoading(false)
        return
      }

      const statsPerAccount = await Promise.all(
        accountRows.map(async (a: Account) => {
          const [totalResult, pendingResult, latestConvo] = await Promise.all([
            supabase
              .from('messages')
              .select('*', { count: 'exact', head: true })
              .eq('account_id', a.id),
            supabase
              .from('messages')
              .select('*', { count: 'exact', head: true })
              .eq('account_id', a.id)
              .eq('reply_required', true)
              .eq('replied', false),
            supabase
              .from('conversations')
              .select('last_message_at')
              .eq('account_id', a.id)
              .order('last_message_at', { ascending: false })
              .limit(1)
              .maybeSingle(),
          ])
          return {
            id: a.id,
            total: totalResult.count || 0,
            pending: pendingResult.count || 0,
            lastMessageAt: (latestConvo.data?.last_message_at as string | null) || null,
          }
        })
      )

      const totalMap = new Map<string, number>()
      const pendingMap = new Map<string, number>()
      const lastMsgMap = new Map<string, string>()

      for (const s of statsPerAccount) {
        totalMap.set(s.id, s.total)
        pendingMap.set(s.id, s.pending)
        if (s.lastMessageAt) lastMsgMap.set(s.id, s.lastMessageAt)
      }

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
  }, [isAdmin, companyAccountIds])

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

  // Group accounts by company name
  const groupMap = new Map<string, CompanyGroup>()
  for (const acc of accounts) {
    if (!acc.is_active) continue
    const baseName = getBaseName(acc.name)
    const existing = groupMap.get(baseName) || {
      baseName,
      email: null,
      teams: null,
      totalMessages: 0,
      pendingReplies: 0,
      lastMessageAt: null,
    }

    if (acc.channel_type === 'email') {
      existing.email = acc
    } else if (acc.channel_type === 'teams') {
      existing.teams = acc
    }

    existing.totalMessages += acc.totalMessages
    existing.pendingReplies += acc.pendingReplies

    // Keep the most recent lastMessageAt
    if (acc.lastMessageAt) {
      if (!existing.lastMessageAt || acc.lastMessageAt > existing.lastMessageAt) {
        existing.lastMessageAt = acc.lastMessageAt
      }
    }

    groupMap.set(baseName, existing)
  }

  const groups = Array.from(groupMap.values()).sort((a, b) => a.baseName.localeCompare(b.baseName))
  const activeAccounts = accounts.filter(a => a.is_active)
  const inactiveAccounts = accounts.filter(a => !a.is_active)
  const totalPending = accounts.reduce((sum, a) => sum + a.pendingReplies, 0)
  const phase2Count = accounts.filter(a => a.phase2_enabled).length
  const companiesCount = groups.length

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Accounts</h1>
          <p className="mt-1 text-sm text-gray-500">
            {companiesCount} companies, {activeAccounts.length}&nbsp;active channels across Email &amp; Teams
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="success" size="md">{companiesCount} Companies</Badge>
          <Badge variant="default" size="md">{activeAccounts.length} Channels</Badge>
        </div>
      </div>

      {/* Stats summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm hover:shadow-md transition-shadow">
          <p className="text-sm text-gray-500">Total Companies</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{companiesCount}</p>
          <div className="mt-2 flex items-center gap-2 text-xs text-gray-400">
            <span className="flex items-center gap-1"><Mail size={10} /> {accounts.filter(a => a.channel_type === 'email' && a.is_active).length} email</span>
            <span className="text-gray-300">|</span>
            <span className="flex items-center gap-1"><MessageSquare size={10} /> {accounts.filter(a => a.channel_type === 'teams' && a.is_active).length} teams</span>
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm hover:shadow-md transition-shadow">
          <p className="text-sm text-gray-500">AI Auto-Reply Active</p>
          <p className="mt-1 text-2xl font-bold text-teal-700">{phase2Count}</p>
          <p className="mt-1 text-xs text-gray-400">Channels with Phase 2 enabled</p>
        </div>
        <div className={cn("rounded-xl border bg-white px-5 py-4 shadow-sm hover:shadow-md transition-shadow", totalPending > 0 ? "border-orange-200" : "border-gray-200")}>
          <p className="text-sm text-gray-500">Pending Replies</p>
          <p className={cn("mt-1 text-2xl font-bold", totalPending > 0 ? "text-orange-600" : "text-gray-900")}>{totalPending}</p>
          {totalPending > 0 && <p className="mt-1 text-xs text-orange-500">Needs attention</p>}
        </div>
      </div>

      {/* Company cards — grouped */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map(group => {
          // Primary account for linking (prefer email, fall back to teams)
          const primary = group.email || group.teams
          if (!primary) return null

          return (
            <div
              key={group.baseName}
              className="rounded-xl border border-gray-200 bg-white shadow-sm transition-all hover:border-teal-300 hover:shadow-md"
            >
              {/* Header */}
              <div className="p-5 pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-lg text-gray-900">{group.baseName}</h3>
                    {group.email?.gmail_address && (
                      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-teal-600 truncate">
                        <Mail size={11} className="shrink-0" />
                        <span className="truncate">{group.email.gmail_address}</span>
                      </p>
                    )}
                  </div>
                  <div
                    className={cn(
                      'flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                      group.pendingReplies > 0
                        ? 'bg-orange-50 text-orange-700'
                        : 'bg-green-50 text-green-700'
                    )}
                  >
                    {group.pendingReplies > 0 ? (
                      <><AlertCircle size={12} /> {group.pendingReplies} pending</>
                    ) : (
                      'All clear'
                    )}
                  </div>
                </div>
              </div>

              {/* Channel rows */}
              <div className="border-t border-gray-100">
                {group.email && (
                  <Link
                    href={`/accounts/${group.email.id}`}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors group"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-50">
                      <ChannelIcon channel="email" size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-700 group-hover:text-teal-700">Email</p>
                      <p className="text-xs text-gray-400">{group.email.totalMessages} messages</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {group.email.pendingReplies > 0 && (
                        <span className="rounded-full bg-orange-100 text-orange-700 px-2 py-0.5 text-xs font-semibold">
                          {group.email.pendingReplies}
                        </span>
                      )}
                      <PhaseIndicator
                        phase1_enabled={group.email.phase1_enabled}
                        phase2_enabled={group.email.phase2_enabled}
                        className="text-xs"
                      />
                    </div>
                  </Link>
                )}

                {group.teams && (
                  <Link
                    href={`/accounts/${group.teams.id}`}
                    className={cn(
                      "flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors group",
                      group.email && "border-t border-gray-50"
                    )}
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
                      <ChannelIcon channel="teams" size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-700 group-hover:text-teal-700">Teams</p>
                      <p className="text-xs text-gray-400">
                        {group.teams.totalMessages > 0
                          ? `${group.teams.totalMessages} messages`
                          : 'No messages yet'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {group.teams.pendingReplies > 0 && (
                        <span className="rounded-full bg-orange-100 text-orange-700 px-2 py-0.5 text-xs font-semibold">
                          {group.teams.pendingReplies}
                        </span>
                      )}
                      <PhaseIndicator
                        phase1_enabled={group.teams.phase1_enabled}
                        phase2_enabled={group.teams.phase2_enabled}
                        className="text-xs"
                      />
                    </div>
                  </Link>
                )}
              </div>

              {/* Footer — combined stats */}
              <div className="border-t border-gray-100 px-5 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-gray-400">
                  <MessageCircle size={12} />
                  <span>{group.totalMessages} total</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-gray-400">
                  <Clock size={12} />
                  <span>{group.lastMessageAt ? timeAgo(group.lastMessageAt) : 'No activity'}</span>
                </div>
              </div>
            </div>
          )
        })}
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
