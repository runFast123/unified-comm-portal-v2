'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  Crown,
  Mail,
  MessageSquare,
  Phone,
  RefreshCw,
  Search,
  Tag,
  UserPlus,
  Users,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useUser } from '@/context/user-context'
import { createClient } from '@/lib/supabase-client'
import { cn, timeAgo } from '@/lib/utils'
import type { ChannelType, Contact } from '@/types/database'

interface ContactRow extends Contact {
  channels: ChannelType[]
}

const PAGE_SIZE = 50

function getInitials(name: string): string {
  return (
    name
      .split(/[\s@.]+/)
      .filter(Boolean)
      .map((p) => p[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || '?'
  )
}

export default function ContactsPage() {
  const supabase = createClient()
  const { isAdmin, companyAccountIds } = useUser()

  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  // Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [vipOnly, setVipOnly] = useState(false)
  const [tagFilter, setTagFilter] = useState('')

  // -------------------------------------------------------------------------
  // Fetch contacts joined with conversations to derive channels-used.
  // For non-admins, restrict to contacts that have at least one conversation
  // in one of their company's accounts.
  // -------------------------------------------------------------------------
  const fetchContacts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // 1) Pull contacts (cap at a sane upper bound for client-side filter/page)
      const { data: contactRows, error: contactErr } = await supabase
        .from('contacts')
        .select(
          'id, email, phone, display_name, notes, tags, first_seen_at, last_seen_at, total_conversations, is_vip'
        )
        .order('last_seen_at', { ascending: false })
        .limit(2000)

      if (contactErr) {
        setError(contactErr.message)
        setLoading(false)
        return
      }

      const contactList = (contactRows || []) as Contact[]
      if (contactList.length === 0) {
        setContacts([])
        setLoading(false)
        return
      }

      // 2) Fetch conversations restricted to either all (admin) or company
      //    accounts (non-admin) so we can derive which channels each contact
      //    has used + filter contacts that don't belong to this company.
      const ids = contactList.map((c) => c.id)
      let convQuery = supabase
        .from('conversations')
        .select('contact_id, channel, account_id')
        .in('contact_id', ids)
        .limit(10000)
      if (!isAdmin && companyAccountIds.length > 0) {
        convQuery = convQuery.in('account_id', companyAccountIds)
      }
      const { data: convRows } = await convQuery

      const channelsByContact = new Map<string, Set<ChannelType>>()
      for (const row of convRows || []) {
        const cid = row.contact_id as string | null
        if (!cid) continue
        const ch = row.channel as ChannelType
        if (!channelsByContact.has(cid)) channelsByContact.set(cid, new Set())
        channelsByContact.get(cid)!.add(ch)
      }

      const enriched: ContactRow[] = contactList
        .map((c) => ({
          ...c,
          channels: Array.from(channelsByContact.get(c.id) || []),
        }))
        // Non-admins: hide contacts with zero conversations in their company.
        .filter((c) => isAdmin || c.channels.length > 0)

      setContacts(enriched)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contacts')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, companyAccountIds.join(',')])

  useEffect(() => {
    fetchContacts()
  }, [fetchContacts])

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------
  const allTags = useMemo(() => {
    const seen = new Set<string>()
    for (const c of contacts) {
      for (const t of c.tags || []) seen.add(t)
    }
    return Array.from(seen).sort()
  }, [contacts])

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return contacts.filter((c) => {
      if (vipOnly && !c.is_vip) return false
      if (tagFilter && !(c.tags || []).includes(tagFilter)) return false
      if (q) {
        const hay = [c.display_name, c.email, c.phone]
          .filter(Boolean)
          .map((s) => (s as string).toLowerCase())
          .join(' ')
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [contacts, searchQuery, vipOnly, tagFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const paginated = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return filtered.slice(start, start + PAGE_SIZE)
  }, [filtered, page])

  useEffect(() => {
    setPage(1)
  }, [searchQuery, vipOnly, tagFilter])

  const stats = useMemo(() => {
    const vipCount = contacts.filter((c) => c.is_vip).length
    // "Active this week" = contact.last_seen_at within the last 7 rolling days.
    //
    // Previously this tile was "New this week" filtered by `first_seen_at`,
    // but the contacts.first_seen_at column was backfilled to `now()` for
    // every contact at the multi-tenancy migration — so on existing
    // installs every single contact appeared "new this week" indefinitely
    // (the audit caught Total=35 / NewThisWeek=35 as a "data bug"). The
    // semantically-correct metric is recent activity, not creation time:
    // last_seen_at is updated by findOrCreateContact on every inbound
    // message, so this naturally diverges from total count and surfaces
    // who's been actively reaching out.
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const activeThisWeek = contacts.filter(
      (c) => c.last_seen_at && new Date(c.last_seen_at).getTime() >= oneWeekAgo
    ).length
    const totalConversations = contacts.reduce(
      (acc, c) => acc + (c.total_conversations || 0),
      0
    )
    return {
      total: contacts.length,
      vipCount,
      activeThisWeek,
      totalConversations,
    }
  }, [contacts])

  // -------------------------------------------------------------------------
  // Render — loading
  // -------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-4 w-72" />
          </div>
          <Skeleton className="h-9 w-24 rounded-lg" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Render — error
  // -------------------------------------------------------------------------
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-24 animate-fade-in">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-red-100">
          <AlertTriangle className="h-6 w-6 text-red-600" />
        </div>
        <p className="font-medium text-red-700">Failed to load contacts</p>
        <p className="mt-1 text-sm text-gray-500">{error}</p>
        <Button variant="secondary" className="mt-4" onClick={() => fetchContacts()}>
          <RefreshCw className="h-4 w-4" />
          Try again
        </Button>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Render — page
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contacts</h1>
          <p className="mt-1 text-sm text-gray-500">
            Unified customer profiles across every channel and account.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => fetchContacts()}
          className="border border-gray-300 bg-white text-gray-600 hover:bg-gray-100 hover:text-gray-700"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile color="blue" icon={Users} label="Total Contacts" value={stats.total} />
        <KpiTile
          color="green"
          icon={UserPlus}
          label="Active This Week"
          value={stats.activeThisWeek}
        />
        <KpiTile color="amber" icon={Crown} label="VIPs" value={stats.vipCount} />
        <KpiTile
          color="purple"
          icon={MessageSquare}
          label="Conversations"
          value={stats.totalConversations}
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <Input
            placeholder="Search by name, email, or phone..."
            icon={<Search className="h-4 w-4" />}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            options={[
              { value: '', label: 'All tags' },
              ...allTags.map((t) => ({ value: t, label: t })),
            ]}
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
          />
        </div>
        {/* VIP-only toggle. Visual treatment communicates "this is a
            toggle, not a navigate-action button":
              - ON: filled amber bg + ring + check dot before the label
              - OFF: empty white bg + dashed border + crown icon at low opacity
            The dashed-vs-solid border switch is the strongest "off vs on"
            visual cue the user can read at a glance. */}
        <button
          type="button"
          onClick={() => setVipOnly((v) => !v)}
          aria-pressed={vipOnly}
          title={vipOnly ? 'Showing VIP contacts only — click to clear filter' : 'Filter to VIP contacts only'}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-all',
            vipOnly
              ? 'border-amber-400 bg-amber-100 text-amber-900 ring-2 ring-amber-200 shadow-inner hover:bg-amber-200'
              : 'border-dashed border-gray-300 bg-white text-gray-600 hover:bg-gray-50 hover:border-amber-300 hover:text-amber-700'
          )}
        >
          {vipOnly ? (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-600" aria-hidden="true" />
          ) : null}
          <Crown className={cn('h-4 w-4', !vipOnly && 'opacity-60')} />
          <span>VIP only</span>
          {vipOnly && (
            <span className="ml-0.5 text-[10px] font-bold uppercase tracking-wide">on</span>
          )}
        </button>
      </div>

      {/* Table */}
      <Card className="!p-0 overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            title={contacts.length === 0 ? 'No contacts yet' : 'No matching contacts'}
            description={
              contacts.length === 0
                ? 'Contacts auto-create as customers reach out across email, Teams, or WhatsApp. Want to import a list instead?'
                : 'Try clearing your search or filter criteria.'
            }
            action={
              contacts.length === 0 ? (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Link href="/admin/channels">
                    <Button variant="primary">
                      <MessageSquare className="h-4 w-4" />
                      Connect a channel
                    </Button>
                  </Link>
                  <Link href="/admin/integrations">
                    <Button variant="secondary">
                      <UserPlus className="h-4 w-4" />
                      Import contacts
                    </Button>
                  </Link>
                </div>
              ) : undefined
            }
            hint={
              contacts.length === 0
                ? 'Contacts populate from inbound conversations — connect a channel to get started.'
                : undefined
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead className="hidden sm:table-cell">Identifier</TableHead>
                  <TableHead className="hidden md:table-cell">Channels</TableHead>
                  <TableHead className="hidden lg:table-cell">Tags</TableHead>
                  <TableHead className="text-right">Conversations</TableHead>
                  <TableHead className="hidden md:table-cell whitespace-nowrap">
                    Last Seen
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.map((c) => {
                  const name = c.display_name?.trim() || c.email || c.phone || 'Unknown'
                  return (
                    <TableRow key={c.id} className="hover:bg-gray-50 transition-colors">
                      <TableCell>
                        <Link
                          href={`/contacts/${c.id}`}
                          className="flex items-center gap-3 group"
                        >
                          <div
                            className={cn(
                              'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1',
                              c.is_vip
                                ? 'bg-amber-100 text-amber-800 ring-amber-200'
                                : 'bg-teal-100 text-teal-700 ring-teal-200'
                            )}
                          >
                            {getInitials(name)}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-gray-900 group-hover:text-teal-700 transition-colors truncate">
                                {name}
                              </span>
                              {c.is_vip && (
                                <Crown className="h-3 w-3 flex-shrink-0 text-amber-600" />
                              )}
                            </div>
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <div className="space-y-0.5">
                          {c.email && (
                            <div className="flex items-center gap-1 text-xs text-gray-600 truncate">
                              <Mail className="h-3 w-3 text-gray-400" />
                              <span className="truncate">{c.email}</span>
                            </div>
                          )}
                          {c.phone && (
                            <div className="flex items-center gap-1 text-xs text-gray-600">
                              <Phone className="h-3 w-3 text-gray-400" />
                              {c.phone}
                            </div>
                          )}
                          {!c.email && !c.phone && (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {c.channels.length === 0 ? (
                          <span className="text-xs text-gray-400">—</span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            {c.channels.map((ch) => {
                              // Channel-brand-coloured pill, no border. Email
                              // = blue, Teams = purple, WhatsApp = green —
                              // matches each platform's identity at a glance.
                              const tint =
                                ch === 'email'
                                  ? 'bg-blue-50 text-blue-600'
                                  : ch === 'teams'
                                  ? 'bg-purple-50 text-purple-600'
                                  : ch === 'whatsapp'
                                  ? 'bg-green-50 text-green-600'
                                  : 'bg-gray-50 text-gray-600'
                              return (
                                <span
                                  key={ch}
                                  title={ch}
                                  className={cn(
                                    'inline-flex h-6 w-6 items-center justify-center rounded-full',
                                    tint
                                  )}
                                >
                                  <ChannelIcon channel={ch} size={12} />
                                </span>
                              )
                            })}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {c.tags && c.tags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {c.tags.slice(0, 3).map((t) => (
                              <Badge key={t} variant="info" size="sm">
                                <Tag className="mr-0.5 h-2.5 w-2.5" /> {t}
                              </Badge>
                            ))}
                            {c.tags.length > 3 && (
                              <span className="text-[10px] text-gray-400">
                                +{c.tags.length - 3}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="font-semibold tabular-nums text-gray-900">
                          {c.total_conversations}
                        </span>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap md:table-cell">
                        <span className="text-sm text-gray-500" suppressHydrationWarning>
                          {c.last_seen_at ? `${timeAgo(c.last_seen_at)} ago` : '—'}
                        </span>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <div className="border-t border-gray-100 px-4">
              <Pagination
                currentPage={page}
                totalPages={totalPages}
                totalItems={filtered.length}
                pageSize={PAGE_SIZE}
                onPageChange={setPage}
              />
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Local KPI tile — kept simple to match the existing aesthetic without
// stomping on the shared `KPICard` component.
// ---------------------------------------------------------------------------
function KpiTile({
  color,
  icon: Icon,
  label,
  value,
}: {
  color: 'blue' | 'green' | 'amber' | 'purple'
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number | string
}) {
  const palette: Record<typeof color, { chip: string; ring: string }> = {
    blue: { chip: 'bg-blue-50 text-blue-700', ring: 'ring-blue-200' },
    green: { chip: 'bg-emerald-50 text-emerald-700', ring: 'ring-emerald-200' },
    amber: { chip: 'bg-amber-50 text-amber-700', ring: 'ring-amber-200' },
    purple: { chip: 'bg-violet-50 text-violet-700', ring: 'ring-violet-200' },
  }
  const p = palette[color]
  return (
    <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-xl ring-1',
            p.chip,
            p.ring
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {label}
          </p>
          <p className="mt-0.5 text-2xl font-semibold tabular-nums text-gray-900">{value}</p>
        </div>
      </div>
    </div>
  )
}

