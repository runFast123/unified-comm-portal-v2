'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  Search,
  RefreshCw,
  Users,
  UserPlus,
  Crown,
  Tag,
  Loader2,
  AlertTriangle,
  Eye,
  MessageSquare,
  Mail,
} from 'lucide-react'
import { createClient } from '@/lib/supabase-client'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Pagination } from '@/components/ui/pagination'
import { Modal } from '@/components/ui/modal'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { timeAgo, cn } from '@/lib/utils'
import { useUser } from '@/context/user-context'
import type { ConversationStatus } from '@/types/database'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccountOption {
  id: string
  name: string
}

interface ContactRecord {
  name: string
  email: string | null
  accountId: string
  accountName: string
  totalConversations: number
  lastMessageAt: string | null
  firstMessageAt: string | null
  topCategory: string | null
  conversations: ContactConversation[]
  emailCount: number
  teamsCount: number
  engagementScore: number
  aiTags: string[]
}

interface ContactConversation {
  id: string
  subject: string | null
  status: ConversationStatus
  category: string | null
  lastMessageAt: string | null
  channel: string
}

type SortOption = 'last_active' | 'most_conversations' | 'name'

const CATEGORIES = [
  'Sales Inquiry',
  'Trouble Ticket',
  'Payment Issue',
  'Service Problem',
  'Technical Issue',
  'Billing Question',
  'Connection Issue',
  'Rate Issue',
  'General Inquiry',
]

const CATEGORY_OPTIONS = [
  { value: '', label: 'All Categories' },
  ...CATEGORIES.map((c) => ({ value: c, label: c })),
]

const SORT_OPTIONS = [
  { value: 'last_active', label: 'Last Active' },
  { value: 'most_conversations', label: 'Most Conversations' },
  { value: 'name', label: 'Name' },
]

function getCategoryVariant(category: string | null): 'info' | 'warning' | 'success' | 'default' {
  switch (category) {
    case 'Technical Issue':
    case 'Connection Issue':
      return 'info'
    case 'Payment Issue':
    case 'Billing Question':
    case 'Rate Issue':
      return 'warning'
    case 'Sales Inquiry':
      return 'success'
    default:
      return 'default'
  }
}

function getStatusVariant(status: ConversationStatus): 'info' | 'warning' | 'success' | 'danger' | 'default' {
  switch (status) {
    case 'active':
    case 'in_progress':
      return 'info'
    case 'waiting_on_customer':
      return 'warning'
    case 'resolved':
      return 'success'
    case 'escalated':
      return 'danger'
    case 'archived':
      return 'default'
    default:
      return 'default'
  }
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function ContactsPage() {
  const supabase = createClient()
  const { isAdmin, companyAccountIds } = useUser()

  const [contacts, setContacts] = useState<ContactRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Pagination
  const CONTACTS_PAGE_SIZE = 25
  const [contactsPage, setContactsPage] = useState(1)

  // Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [accountFilter, setAccountFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('last_active')

  // Accounts for filter
  const [accounts, setAccounts] = useState<AccountOption[]>([])

  // View History modal
  const [selectedContact, setSelectedContact] = useState<ContactRecord | null>(null)
  const [historyModalOpen, setHistoryModalOpen] = useState(false)

  // -------------------------------------------------------------------------
  // Fetch accounts for filter/selector
  // -------------------------------------------------------------------------
  const fetchAccounts = useCallback(async () => {
    let query = supabase
      .from('accounts')
      .select('id, name')
      .eq('is_active', true)
      .order('name')
    if (!isAdmin && companyAccountIds.length > 0) {
      query = query.in('id', companyAccountIds)
    }
    const { data } = await query
    if (data) setAccounts(data)
  }, [isAdmin, companyAccountIds])

  // -------------------------------------------------------------------------
  // Fetch contacts — aggregated from conversations + messages
  // -------------------------------------------------------------------------
  const fetchContacts = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      // 1) Fetch conversations with their participant info
      let convQuery = supabase
        .from('conversations')
        .select(`
          id,
          account_id,
          participant_name,
          participant_email,
          status,
          channel,
          first_message_at,
          last_message_at,
          account:accounts!inner(id, name)
        `)
        .not('participant_name', 'is', null)
        .limit(10000)

      // Company scoping for non-admins (include sibling channel accounts)
      if (!isAdmin && companyAccountIds.length > 0) {
        convQuery = convQuery.in('account_id', companyAccountIds)
      }

      const { data: conversations, error: convError } = await convQuery

      if (convError) {
        setError(convError.message)
        setLoading(false)
        return
      }

      // 2) Fetch classifications per conversation for category data
      const convIds = (conversations || []).map((c: Record<string, unknown>) => c.id as string)
      const classificationMap: Record<string, string> = {}

      if (convIds.length > 0) {
        // Fetch messages with their classifications for the relevant conversations
        // Batch in chunks to avoid query size limits
        const chunkSize = 50
        for (let i = 0; i < convIds.length; i += chunkSize) {
          const chunk = convIds.slice(i, i + chunkSize)
          const { data: msgData } = await supabase
            .from('messages')
            .select('conversation_id, classification:message_classifications(category)')
            .in('conversation_id', chunk)

          if (msgData) {
            const convCategoryCounts: Record<string, Record<string, number>> = {}
            for (const msg of msgData) {
              const convId = msg.conversation_id
              const rawCl = msg.classification as unknown
              const classifications: Array<{ category: string }> = Array.isArray(rawCl)
                ? rawCl
                : rawCl ? [rawCl as { category: string }] : []
              if (classifications.length === 0) continue
              for (const cl of classifications) {
                if (!convCategoryCounts[convId]) convCategoryCounts[convId] = {}
                convCategoryCounts[convId][cl.category] = (convCategoryCounts[convId][cl.category] || 0) + 1
              }
            }
            for (const [convId, counts] of Object.entries(convCategoryCounts)) {
              const topCat = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
              if (topCat) classificationMap[convId] = topCat[0]
            }
          }
        }
      }

      // 3) Aggregate contacts by (name + email) key
      const contactMap = new Map<string, ContactRecord>()

      for (const conv of (conversations || [])) {
        const name = (conv.participant_name as string) || 'Unknown'
        const email = conv.participant_email as string | null
        // Supabase join may return object or array — handle both
        const rawAcc = conv.account as unknown
        const acc: { id: string; name: string } = Array.isArray(rawAcc)
          ? (rawAcc[0] ?? { id: conv.account_id, name: 'Unknown' })
          : (rawAcc as { id: string; name: string }) ?? { id: conv.account_id as string, name: 'Unknown' }
        const key = `${name.toLowerCase()}||${(email || '').toLowerCase()}||${acc.id}`

        if (!contactMap.has(key)) {
          contactMap.set(key, {
            name,
            email,
            accountId: acc.id,
            accountName: acc.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim(),
            totalConversations: 0,
            lastMessageAt: null,
            firstMessageAt: null,
            topCategory: null,
            conversations: [],
            emailCount: 0,
            teamsCount: 0,
            engagementScore: 0,
            aiTags: [],
          })
        }

        const contact = contactMap.get(key)!
        contact.totalConversations += 1

        // Track earliest / latest
        const lastMsg = conv.last_message_at as string | null
        const firstMsg = conv.first_message_at as string | null

        if (lastMsg && (!contact.lastMessageAt || lastMsg > contact.lastMessageAt)) {
          contact.lastMessageAt = lastMsg
        }
        if (firstMsg && (!contact.firstMessageAt || firstMsg < contact.firstMessageAt)) {
          contact.firstMessageAt = firstMsg
        }

        // Email subject from first message or use participant name
        const subject = email
          ? `Conversation via ${conv.channel}`
          : `${conv.channel} conversation`

        // Track channel counts
        const ch = conv.channel as string
        if (ch === 'email') contact.emailCount++
        else if (ch === 'teams') contact.teamsCount++

        contact.conversations.push({
          id: conv.id as string,
          subject,
          status: conv.status as ConversationStatus,
          category: classificationMap[conv.id as string] || null,
          lastMessageAt: lastMsg,
          channel: ch,
        })
      }

      // 4) Calculate top category per contact (must run BEFORE AI tags so Sales/Support tags work)
      for (const contact of contactMap.values()) {
        const catCounts: Record<string, number> = {}
        for (const conv of contact.conversations) {
          if (conv.category) {
            catCounts[conv.category] = (catCounts[conv.category] || 0) + 1
          }
        }
        const topCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0]
        contact.topCategory = topCat ? topCat[0] : null

        // Sort conversations by date descending
        contact.conversations.sort((a, b) => {
          if (!a.lastMessageAt) return 1
          if (!b.lastMessageAt) return -1
          return b.lastMessageAt.localeCompare(a.lastMessageAt)
        })
      }

      // 5) Compute engagement scores + AI auto-tags (after topCategory is set)
      for (const contact of contactMap.values()) {
        const recencyDays = contact.lastMessageAt
          ? Math.max(0, (Date.now() - new Date(contact.lastMessageAt).getTime()) / (1000 * 60 * 60 * 24))
          : 30
        const recencyWeight = Math.max(0.1, 1 - recencyDays / 30)
        contact.engagementScore = Math.round(contact.totalConversations * recencyWeight * 10)

        // AI Auto-Tags
        const tags: string[] = []
        if (contact.engagementScore >= 50 && contact.totalConversations >= 3) tags.push('VIP')
        if (contact.firstMessageAt && recencyDays <= 7 && contact.totalConversations <= 2) tags.push('New Lead')
        if (recencyDays >= 30 && contact.totalConversations >= 2) tags.push('Churning')
        const hasEscalated = contact.conversations.some(c => c.status === 'escalated')
        if (hasEscalated) tags.push('At Risk')
        if (contact.topCategory === 'Sales Inquiry') tags.push('Sales')
        if (contact.topCategory === 'Trouble Ticket' || contact.topCategory === 'Technical Issue') tags.push('Support')
        contact.aiTags = tags
      }

      setContacts(Array.from(contactMap.values()))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contacts')
    } finally {
      setLoading(false)
    }
  }, [isAdmin, companyAccountIds])

  useEffect(() => {
    fetchContacts()
    fetchAccounts()
  }, [fetchContacts, fetchAccounts])

  // -------------------------------------------------------------------------
  // Derived stats
  // -------------------------------------------------------------------------
  const totalContacts = contacts.length

  const newThisWeek = useMemo(() => {
    const oneWeekAgo = new Date()
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)
    const cutoff = oneWeekAgo.toISOString()
    return contacts.filter((c) => c.firstMessageAt && c.firstMessageAt >= cutoff).length
  }, [contacts])

  const mostActiveContact = useMemo(() => {
    if (contacts.length === 0) return 'N/A'
    const sorted = [...contacts].sort((a, b) => b.totalConversations - a.totalConversations)
    return sorted[0].name
  }, [contacts])

  const topCategory = useMemo(() => {
    const catCounts: Record<string, number> = {}
    for (const c of contacts) {
      if (c.topCategory) {
        catCounts[c.topCategory] = (catCounts[c.topCategory] || 0) + c.totalConversations
      }
    }
    const top = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0]
    return top ? top[0] : 'N/A'
  }, [contacts])

  // -------------------------------------------------------------------------
  // Filtered + sorted contacts
  // -------------------------------------------------------------------------
  const filteredContacts = useMemo(() => {
    let result = contacts.filter((contact) => {
      const matchesSearch =
        !searchQuery ||
        contact.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (contact.email && contact.email.toLowerCase().includes(searchQuery.toLowerCase()))
      const matchesAccount = !accountFilter || contact.accountId === accountFilter
      const matchesCategory = !categoryFilter || contact.topCategory === categoryFilter
      return matchesSearch && matchesAccount && matchesCategory
    })

    // Sort
    switch (sortBy) {
      case 'last_active':
        result.sort((a, b) => {
          if (!a.lastMessageAt) return 1
          if (!b.lastMessageAt) return -1
          return b.lastMessageAt.localeCompare(a.lastMessageAt)
        })
        break
      case 'most_conversations':
        result.sort((a, b) => b.totalConversations - a.totalConversations)
        break
      case 'name':
        result.sort((a, b) => a.name.localeCompare(b.name))
        break
    }

    return result
  }, [contacts, searchQuery, accountFilter, categoryFilter, sortBy])

  // Reset to page 1 when filters change
  useEffect(() => {
    setContactsPage(1)
  }, [searchQuery, accountFilter, categoryFilter, sortBy])

  const totalContactPages = Math.ceil(filteredContacts.length / CONTACTS_PAGE_SIZE)
  const paginatedContacts = useMemo(() => {
    const start = (contactsPage - 1) * CONTACTS_PAGE_SIZE
    return filteredContacts.slice(start, start + CONTACTS_PAGE_SIZE)
  }, [filteredContacts, contactsPage, CONTACTS_PAGE_SIZE])

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------
  function handleViewHistory(contact: ContactRecord) {
    setSelectedContact(contact)
    setHistoryModalOpen(true)
  }

  function handleCloseHistory() {
    setHistoryModalOpen(false)
    setSelectedContact(null)
  }

  // -------------------------------------------------------------------------
  // Render: Loading
  // -------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="flex h-80 items-center justify-center animate-fade-in">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-xl bg-blue-100 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-gray-700">Loading contacts</p>
            <p className="text-xs text-gray-400 mt-1">Aggregating customer data...</p>
          </div>
        </div>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Render: Error
  // -------------------------------------------------------------------------
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-24 animate-fade-in">
        <div className="h-12 w-12 rounded-xl bg-red-100 flex items-center justify-center mb-4">
          <AlertTriangle className="h-6 w-6 text-red-600" />
        </div>
        <p className="text-red-700 font-medium">Failed to load contacts</p>
        <p className="text-sm text-gray-500 mt-1">{error}</p>
        <Button variant="secondary" className="mt-4" onClick={() => fetchContacts()}>
          <RefreshCw className="h-4 w-4" />
          Try Again
        </Button>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Render: Page
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-6 animate-fade-in">
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contacts</h1>
          <p className="mt-1 text-sm text-gray-500">
            Customer contact history aggregated from all conversations
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => fetchContacts()}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Total Contacts</p>
              <p className="text-2xl font-bold text-gray-900">{totalContacts}</p>
            </div>
          </div>
        </Card>
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100 text-green-700">
              <UserPlus className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">New This Week</p>
              <p className="text-2xl font-bold text-gray-900">{newThisWeek}</p>
            </div>
          </div>
        </Card>
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100 text-purple-700">
              <Crown className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Most Active</p>
              <p className="text-lg font-bold text-gray-900 truncate max-w-[160px]" title={mostActiveContact}>
                {mostActiveContact}
              </p>
            </div>
          </div>
        </Card>
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-100 text-orange-700">
              <Tag className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Top Category</p>
              <p className="text-lg font-bold text-gray-900 truncate max-w-[160px]" title={topCategory}>
                {topCategory}
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <Input
            placeholder="Search by name or email..."
            icon={<Search className="h-4 w-4" />}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        {isAdmin && (
          <div className="w-full sm:w-48">
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="">All Companies</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="w-full sm:w-48">
          <Select
            options={CATEGORY_OPTIONS}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            options={SORT_OPTIONS}
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
          />
        </div>
      </div>

      {/* Contacts table */}
      <Card>
        {filteredContacts.length === 0 ? (
          <EmptyState
            icon={<Users className="h-12 w-12" />}
            title="No contacts found"
            description={
              contacts.length === 0
                ? 'No customer conversations have been recorded yet. Contacts will appear here as customers message your accounts.'
                : 'Try adjusting your search or filter criteria.'
            }
          />
        ) : (
          <><Table>
            <TableHeader>
              <TableRow>
                <TableHead>Contact</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Channels</TableHead>
                <TableHead>Conversations</TableHead>
                <TableHead className="hidden md:table-cell">Engagement</TableHead>
                <TableHead className="hidden lg:table-cell">AI Tags</TableHead>
                <TableHead className="hidden md:table-cell">Last Contact</TableHead>
                <TableHead className="hidden lg:table-cell">Top Category</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedContacts.map((contact, idx) => {
                const key = `${contact.name}-${contact.email || ''}-${contact.accountId}-${idx}`
                return (
                  <TableRow
                    key={key}
                    className="cursor-pointer hover:bg-gray-50 transition-colors"
                    onClick={() => handleViewHistory(contact)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-100 text-xs font-semibold text-teal-700">
                          {getInitials(contact.name)}
                        </div>
                        <span className="font-medium text-gray-900">{contact.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="info" size="sm">{contact.accountName}</Badge>
                        {contact.email && (
                          <span className="text-xs text-gray-400 hidden xl:inline truncate max-w-[120px]">{contact.email}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {contact.emailCount > 0 && (
                          <span className="flex items-center gap-0.5 rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-600">
                            <Mail className="h-2.5 w-2.5" /> {contact.emailCount}
                          </span>
                        )}
                        {contact.teamsCount > 0 && (
                          <span className="flex items-center gap-0.5 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600">
                            <MessageSquare className="h-2.5 w-2.5" /> {contact.teamsCount}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="font-semibold text-gray-900">{contact.totalConversations}</span>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="flex items-center gap-1.5">
                        <div className="h-2 w-16 rounded-full bg-gray-100 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              contact.engagementScore >= 50 ? 'bg-green-500' : contact.engagementScore >= 20 ? 'bg-amber-500' : 'bg-gray-300'
                            }`}
                            style={{ width: `${Math.min(contact.engagementScore, 100)}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500">{contact.engagementScore}</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {contact.aiTags.map((tag, ti) => (
                          <span key={ti} className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                            tag === 'VIP' ? 'bg-amber-100 text-amber-700' :
                            tag === 'At Risk' ? 'bg-red-100 text-red-700' :
                            tag === 'New Lead' ? 'bg-green-100 text-green-700' :
                            tag === 'Churning' ? 'bg-orange-100 text-orange-700' :
                            tag === 'Sales' ? 'bg-blue-100 text-blue-700' :
                            tag === 'Support' ? 'bg-purple-100 text-purple-700' :
                            'bg-gray-100 text-gray-600'
                          )}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap md:table-cell">
                      <span className="text-sm text-gray-500">
                        {contact.lastMessageAt ? timeAgo(contact.lastMessageAt) + ' ago' : 'N/A'}
                      </span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {contact.topCategory ? (
                        <Badge variant={getCategoryVariant(contact.topCategory)} size="sm">
                          {contact.topCategory}
                        </Badge>
                      ) : (
                        <span className="text-sm text-gray-400">--</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleViewHistory(contact) }}
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-teal-700 bg-teal-50 hover:bg-teal-100 transition-colors"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        View History
                      </button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <Pagination
            currentPage={contactsPage}
            totalPages={totalContactPages}
            totalItems={filteredContacts.length}
            pageSize={CONTACTS_PAGE_SIZE}
            onPageChange={setContactsPage}
          />
          </>
        )}
      </Card>

      {/* View History Modal */}
      <Modal
        open={historyModalOpen}
        onClose={handleCloseHistory}
        title={selectedContact ? `${selectedContact.name} — Contact History` : 'Contact History'}
        className="sm:max-w-2xl"
        footer={
          <Button variant="secondary" onClick={handleCloseHistory}>
            Close
          </Button>
        }
      >
        {selectedContact && (
          <div className="space-y-5">
            {/* Contact info header */}
            <div className="rounded-lg bg-gray-50 p-4">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-teal-100 text-sm font-bold text-teal-700">
                  {getInitials(selectedContact.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-gray-900">{selectedContact.name}</h3>
                  {selectedContact.email && (
                    <p className="flex items-center gap-1 text-sm text-gray-500">
                      <Mail className="h-3.5 w-3.5" />
                      {selectedContact.email}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-gray-500">Company</p>
                  <p className="text-sm font-medium text-gray-700">{selectedContact.accountName}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Conversations</p>
                  <p className="text-sm font-medium text-gray-700">{selectedContact.totalConversations}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">First Seen</p>
                  <p className="text-sm font-medium text-gray-700">
                    {selectedContact.firstMessageAt
                      ? timeAgo(selectedContact.firstMessageAt) + ' ago'
                      : 'N/A'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Last Seen</p>
                  <p className="text-sm font-medium text-gray-700">
                    {selectedContact.lastMessageAt
                      ? timeAgo(selectedContact.lastMessageAt) + ' ago'
                      : 'N/A'}
                  </p>
                </div>
              </div>
            </div>

            {/* Conversation list */}
            <div>
              <h4 className="mb-3 text-sm font-semibold text-gray-700">All Conversations</h4>
              {selectedContact.conversations.length === 0 ? (
                <p className="text-sm text-gray-400">No conversations recorded.</p>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {selectedContact.conversations.map((conv) => (
                    <Link
                      key={conv.id}
                      href={`/conversations/${conv.id}`}
                      className="flex items-center justify-between rounded-lg border border-gray-100 p-3 hover:bg-gray-50 transition-colors group"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 group-hover:text-teal-700 transition-colors truncate">
                          {conv.subject || 'Untitled Conversation'}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <Badge variant={getStatusVariant(conv.status)} size="sm">
                            {conv.status.replace(/_/g, ' ')}
                          </Badge>
                          {conv.category && (
                            <Badge variant={getCategoryVariant(conv.category)} size="sm">
                              {conv.category}
                            </Badge>
                          )}
                          <span className="text-xs text-gray-400 capitalize">{conv.channel}</span>
                        </div>
                      </div>
                      <div className="ml-3 flex-shrink-0 text-right">
                        <p className="text-xs text-gray-400">
                          {conv.lastMessageAt ? timeAgo(conv.lastMessageAt) + ' ago' : 'N/A'}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
