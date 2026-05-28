import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Crown, Mail, MessageSquare, Phone } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { cn, getChannelLabel, timeAgo } from '@/lib/utils'
import type { ChannelType, Contact, ConversationStatus } from '@/types/database'

import { ContactProfileClient } from './contact-profile-client'

function getInitials(name: string | null | undefined, fallback: string): string {
  const source = (name && name.trim()) || fallback
  return source
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?'
}

function statusVariant(status: ConversationStatus): 'info' | 'warning' | 'success' | 'danger' | 'default' {
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
    default:
      return 'default'
  }
}

function stripChannelSuffix(name: string): string {
  return name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
}

interface ConversationRow {
  id: string
  channel: ChannelType
  status: ConversationStatus
  participant_name: string | null
  participant_email: string | null
  last_message_at: string | null
  first_message_at: string | null
  account_id: string
}

export default async function ContactProfilePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) notFound()

  // Profile lookup for admin gating + display.
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  const isAdmin = ['admin','super_admin','company_admin'].includes(profile?.role ?? '')
  // Phase 2 gate: supervisor-or-above may edit a contact's fields. Members
  // get a read-only view (no display-name field, no notes textarea, no tag
  // chips with remove buttons, no VIP toggle). The PATCH /api/contacts/[id]
  // route enforces the same check server-side.
  const canEditContact = ['admin','super_admin','company_admin','supervisor'].includes(profile?.role ?? '')

  const { data: contactRow, error: contactErr } = await admin
    .from('contacts')
    .select(
      'id, email, phone, display_name, notes, tags, first_seen_at, last_seen_at, total_conversations, is_vip'
    )
    .eq('id', id)
    .maybeSingle()
  if (contactErr || !contactRow) notFound()
  const contact = contactRow as Contact

  // Fetch ALL conversations for this contact, joined with account.name.
  // Uses contact_id directly (FK is backfilled). Sort newest-first.
  const { data: conversationsRaw } = await admin
    .from('conversations')
    .select(
      'id, channel, status, participant_name, participant_email, first_message_at, last_message_at, account_id'
    )
    .eq('contact_id', id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(500)

  const conversations = (conversationsRaw || []) as ConversationRow[]

  // Pull account names in one shot.
  const accountIds = Array.from(new Set(conversations.map((c) => c.account_id))).filter(Boolean)
  const accountNameById = new Map<string, string>()
  if (accountIds.length > 0) {
    const { data: accountsRaw } = await admin
      .from('accounts')
      .select('id, name')
      .in('id', accountIds)
    for (const a of accountsRaw || []) {
      accountNameById.set(a.id as string, stripChannelSuffix(a.name as string))
    }
  }

  // Channels seen across all conversations.
  const channelsUsed = new Set<ChannelType>()
  for (const c of conversations) channelsUsed.add(c.channel)

  const headerName = contact.display_name?.trim() || contact.email || contact.phone || 'Unknown contact'
  const initials = getInitials(contact.display_name, contact.email || contact.phone || '')

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Back link */}
      <div>
        <Link
          href="/contacts"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-teal-700 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          All contacts
        </Link>
      </div>

      {/* Header card */}
      <div
        className={cn(
          'relative overflow-hidden rounded-2xl border bg-white p-6',
          'shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]',
          contact.is_vip ? 'border-amber-200 ring-1 ring-amber-100' : 'border-gray-200/80'
        )}
      >
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-6">
          <div
            className={cn(
              'flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl text-xl font-bold ring-1',
              contact.is_vip
                ? 'bg-amber-100 text-amber-800 ring-amber-200'
                : 'bg-teal-100 text-teal-700 ring-teal-200'
            )}
          >
            {initials}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-bold tracking-tight text-gray-900">
                {headerName}
              </h1>
              {contact.is_vip && (
                <Badge variant="warning" size="sm">
                  <Crown className="mr-1 h-3 w-3" /> VIP
                </Badge>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500">
              {contact.email && (
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5" />
                  {contact.email}
                </span>
              )}
              {contact.phone && (
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5" />
                  {contact.phone}
                </span>
              )}
              {!contact.email && !contact.phone && (
                <span className="text-gray-400">No contact info</span>
              )}
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-6 sm:border-l sm:border-gray-100 sm:pl-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Conversations
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">
                {contact.total_conversations}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                First Seen
              </p>
              <p className="mt-1 text-sm font-medium text-gray-700" suppressHydrationWarning>
                {timeAgo(contact.first_seen_at)} ago
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Last Seen
              </p>
              <p className="mt-1 text-sm font-medium text-gray-700" suppressHydrationWarning>
                {timeAgo(contact.last_seen_at)} ago
              </p>
            </div>
          </div>
        </div>

        {channelsUsed.size > 0 && (
          <div className="mt-5 flex items-center gap-2 border-t border-gray-100 pt-4">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Channels
            </span>
            <div className="flex items-center gap-2">
              {Array.from(channelsUsed).map((ch) => (
                <span
                  key={ch}
                  className="inline-flex items-center gap-1 rounded-full bg-gray-50 px-2 py-1 text-xs text-gray-600 ring-1 ring-gray-200"
                >
                  <ChannelIcon channel={ch} size={12} />
                  {getChannelLabel(ch)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Two-column layout: editable client island + activity */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <ContactProfileClient
            contactId={contact.id}
            initialNotes={contact.notes ?? ''}
            initialTags={contact.tags ?? []}
            initialIsVip={contact.is_vip}
            initialDisplayName={contact.display_name ?? ''}
            isAdmin={isAdmin}
            canEdit={canEditContact}
          />
        </div>

        {/* Activity */}
        <div className="lg:col-span-3">
          <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-gray-900">
                  Activity
                </h2>
                <p className="mt-0.5 text-xs text-gray-500">
                  All conversations across every account this contact has reached.
                </p>
              </div>
              <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-gray-600">
                {conversations.length}
              </span>
            </div>

            <div className="mt-4 space-y-2">
              {conversations.length === 0 ? (
                <p className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
                  No conversations linked to this contact yet.
                </p>
              ) : (
                conversations.map((conv) => {
                  const accName = accountNameById.get(conv.account_id) || 'Unknown account'
                  const subjectFallback =
                    conv.participant_name?.trim() ||
                    conv.participant_email ||
                    `${getChannelLabel(conv.channel)} conversation`
                  return (
                    <Link
                      key={conv.id}
                      href={`/conversations/${conv.id}`}
                      className="group flex items-center gap-3 rounded-xl border border-gray-100 px-3 py-2.5 transition-colors hover:border-gray-200 hover:bg-gray-50"
                    >
                      <ChannelIcon channel={conv.channel} size={16} className="flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-gray-900 group-hover:text-teal-700">
                          {subjectFallback}
                        </p>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                          <span>{accName}</span>
                          <span className="text-gray-300">&middot;</span>
                          <span>{getChannelLabel(conv.channel)}</span>
                        </div>
                      </div>
                      <Badge variant={statusVariant(conv.status)} size="sm">
                        {conv.status.replace(/_/g, ' ')}
                      </Badge>
                      <span
                        className="hidden flex-shrink-0 text-right text-xs tabular-nums text-gray-400 sm:block"
                        suppressHydrationWarning
                      >
                        {conv.last_message_at ? `${timeAgo(conv.last_message_at)} ago` : '—'}
                      </span>
                    </Link>
                  )
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
