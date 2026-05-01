'use client'

import { useState, useCallback, useEffect } from 'react'
import { createClient } from '@/lib/supabase-client'
import type { Account, Company } from '@/types/database'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import { Badge } from '@/components/ui/badge'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { PhaseIndicator } from '@/components/ui/phase-indicator'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Modal } from '@/components/ui/modal'
import { Input } from '@/components/ui/input'
import { getChannelLabel, timeAgo } from '@/lib/utils'
import { Search, Filter, ChevronRight, Loader2, Check, AlertCircle, X, Plug } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'

const SPAM_ALLOWLIST_MAX = 50

const COMMON_TIMEZONES = [
  'Asia/Kuala_Lumpur',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Jakarta',
  'Asia/Bangkok',
  'Asia/Manila',
  'Australia/Sydney',
  'Pacific/Auckland',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'UTC',
]

// AI tone presets. Picking one in the dropdown fills the system-prompt textarea;
// the admin can further edit it. These are seed prompts, not locked presets.
const AI_TONE_PRESETS = {
  friendly:
    "You are a warm, friendly customer service agent. Use conversational language, contractions, and occasional light exclamations. Acknowledge the customer's feelings where relevant. Keep it professional but never stiff. Avoid jargon.",
  formal:
    "You are a formal, professional customer service agent. Use complete sentences, precise language, and a polite register. Avoid contractions and slang. Open with a greeting and close with a proper sign-off.",
  terse:
    "You are an efficient customer service agent. Write extremely short replies — ideally 1-3 sentences. No pleasantries, no filler. Lead with the answer or action. Use bullet points if listing more than one item.",
  empathetic:
    "You are a patient, empathetic customer service agent. Validate the customer's concern before addressing it. Use phrases like \"I understand this is frustrating\" when appropriate. Focus on reassurance alongside the facts.",
  sales:
    "You are an enthusiastic sales-minded agent. Highlight value and benefits, not just features. Suggest an obvious next step (call to action) in every reply. Match the customer's energy — warm but never pushy.",
  clear:
    "You are a clear, plain-English customer service agent. Use short sentences. Avoid jargon, marketing language, and filler. Every reply should answer the customer's question directly and tell them what happens next.",
} as const

interface ModalFormState {
  company_id: string | null
  ai_auto_reply: boolean
  ai_trust_mode: boolean
  ai_confidence_threshold: number
  working_hours_start: string
  working_hours_end: string
  working_timezone: string
  ai_system_prompt: string
  sla_warning_hours: number
  sla_critical_hours: number
  sla_auto_escalate: boolean
  spam_detection_enabled: boolean
  spam_allowlist: string[]
  monthly_ai_budget_usd: number
  ai_budget_alert_at_pct: number
  // Out-of-office auto-reply config (datetime-local strings; persisted as ISO).
  ooo_enabled: boolean
  ooo_starts_at: string
  ooo_ends_at: string
  ooo_subject: string
  ooo_body: string
}

/**
 * Convert an ISO timestamp (or null) to the value an `<input type="datetime-local">`
 * expects: "yyyy-MM-ddTHH:mm" in the LOCAL timezone. The browser-native input
 * is local-time-only, so we need to format from the user's perspective.
 */
function isoToDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Convert a `datetime-local` value back to an ISO string (UTC). The
 * browser parses the local value with the user's timezone applied so
 * `new Date(local)` yields the right instant.
 */
function datetimeLocalToIso(local: string): string | null {
  if (!local) return null
  const t = Date.parse(local)
  if (!Number.isFinite(t)) return null
  return new Date(t).toISOString()
}

/** Format an ISO timestamp for the OOO banner ("Apr 30, 2026, 5:00 PM"). */
function formatOOOEnd(iso: string | null | undefined): string {
  if (!iso) return 'further notice'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'further notice'
  return new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * Returns true if the account's OOO window is active right now.
 * Mirrors the server-side `isAccountOOO` so the badge / banner stay
 * in sync without a round-trip.
 */
function isAccountOOOActive(a: Account): boolean {
  if (!a.ooo_enabled) return false
  const now = Date.now()
  if (a.ooo_starts_at) {
    const t = Date.parse(a.ooo_starts_at)
    if (Number.isFinite(t) && now < t) return false
  }
  if (a.ooo_ends_at) {
    const t = Date.parse(a.ooo_ends_at)
    if (Number.isFinite(t) && now > t) return false
  }
  return true
}

// Sentinel value used in the company <select> to mean "open the inline
// new-company input". Keeps the picker single-control without a separate
// modal and avoids colliding with any UUID.
const NEW_COMPANY_SENTINEL = '__new__'

/**
 * Normalize a raw allowlist entry: trim, lowercase, drop empty.
 * Returns null if the entry is unusable.
 */
function normalizeAllowlistEntry(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

export default function AccountsPage() {
  const supabase = createClient()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [channelFilter, setChannelFilter] = useState<'all' | 'teams' | 'email' | 'whatsapp'>('all')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [detailAccount, setDetailAccount] = useState<Account | null>(null)
  const [modalForm, setModalForm] = useState<ModalFormState | null>(null)
  const [allowlistDraft, setAllowlistDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [companies, setCompanies] = useState<Company[]>([])
  // When the user picks "+ Create new company" we reveal an inline input.
  const [newCompanyDraft, setNewCompanyDraft] = useState('')
  const [showNewCompanyInput, setShowNewCompanyInput] = useState(false)
  // Current-month AI spend for the open account (null while loading / error).
  const [aiSpendThisMonth, setAiSpendThisMonth] = useState<number | null>(null)

  // Fetch companies once on mount — small table, fine to load eagerly.
  useEffect(() => {
    let cancelled = false
    async function fetchCompanies() {
      const { data, error: fetchError } = await supabase
        .from('companies')
        .select('id, name, created_at')
        .order('name', { ascending: true })
      if (cancelled) return
      if (fetchError) {
        console.error('Failed to fetch companies:', fetchError.message)
        return
      }
      setCompanies((data ?? []) as Company[])
    }
    fetchCompanies()
    return () => { cancelled = true }
  }, [supabase])

  // Initialize modal form when detailAccount changes
  useEffect(() => {
    if (detailAccount) {
      setModalForm({
        company_id: detailAccount.company_id ?? null,
        ai_auto_reply: detailAccount.ai_auto_reply,
        ai_trust_mode: detailAccount.ai_trust_mode,
        ai_confidence_threshold: detailAccount.ai_confidence_threshold,
        working_hours_start: detailAccount.working_hours_start ?? '09:00:00',
        working_hours_end: detailAccount.working_hours_end ?? '18:00:00',
        working_timezone: detailAccount.working_timezone ?? 'Asia/Kuala_Lumpur',
        ai_system_prompt: detailAccount.ai_system_prompt ?? '',
        sla_warning_hours: detailAccount.sla_warning_hours ?? 2,
        sla_critical_hours: detailAccount.sla_critical_hours ?? 4,
        sla_auto_escalate: detailAccount.sla_auto_escalate ?? true,
        spam_detection_enabled: detailAccount.spam_detection_enabled ?? true,
        spam_allowlist: Array.isArray(detailAccount.spam_allowlist)
          ? detailAccount.spam_allowlist
          : [],
        monthly_ai_budget_usd: Number(detailAccount.monthly_ai_budget_usd ?? 50),
        ai_budget_alert_at_pct: Number(detailAccount.ai_budget_alert_at_pct ?? 90),
        ooo_enabled: !!detailAccount.ooo_enabled,
        ooo_starts_at: isoToDatetimeLocal(detailAccount.ooo_starts_at ?? null),
        ooo_ends_at: isoToDatetimeLocal(detailAccount.ooo_ends_at ?? null),
        ooo_subject: detailAccount.ooo_subject ?? 'Out of office',
        ooo_body: detailAccount.ooo_body ?? '',
      })
      setAllowlistDraft('')
      setShowNewCompanyInput(false)
      setNewCompanyDraft('')
    } else {
      setModalForm(null)
      setAllowlistDraft('')
      setShowNewCompanyInput(false)
      setNewCompanyDraft('')
    }
  }, [detailAccount])

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3500)
      return () => clearTimeout(timer)
    }
  }, [toast])

  // Fetch current-month AI spend whenever the detail modal opens.
  // Uses the `account_ai_spend_this_month` RPC directly via the client.
  useEffect(() => {
    if (!detailAccount) {
      setAiSpendThisMonth(null)
      return
    }
    let cancelled = false
    async function fetchSpend() {
      if (!detailAccount) return
      const { data, error: rpcError } = await supabase.rpc(
        'account_ai_spend_this_month',
        { p_account_id: detailAccount.id }
      )
      if (cancelled) return
      if (rpcError) {
        console.error('Failed to fetch AI spend:', rpcError.message)
        setAiSpendThisMonth(null)
        return
      }
      setAiSpendThisMonth(Number(data ?? 0))
    }
    fetchSpend()
    return () => { cancelled = true }
  }, [detailAccount, supabase])

  // Instantly persist a single field (or a small batch) to the DB
  const saveField = useCallback(async (fields: Record<string, unknown>) => {
    if (!detailAccount) return
    const { error: updateError } = await supabase
      .from('accounts')
      .update(fields)
      .eq('id', detailAccount.id)

    if (updateError) {
      setToast({ type: 'error', message: `Failed to save: ${updateError.message}` })
      return false
    }

    // Sync local accounts list
    setAccounts((prev) =>
      prev.map((a) => (a.id === detailAccount.id ? { ...a, ...fields } as Account : a))
    )
    setDetailAccount((prev) => (prev ? { ...prev, ...fields } as Account : null))
    return true
  }, [detailAccount, supabase])

  // Toggle handler that auto-saves a boolean field to DB immediately
  const toggleField = useCallback(async (field: keyof ModalFormState, value: boolean) => {
    // Optimistic UI update
    setModalForm((prev) => prev ? { ...prev, [field]: value } : prev)
    const saved = await saveField({ [field]: value })
    if (!saved) {
      // Revert on failure
      setModalForm((prev) => prev ? { ...prev, [field]: !value } : prev)
    }
  }, [saveField])

  const saveAccountSettings = useCallback(async () => {
    if (!detailAccount || !modalForm) return

    // Guard: if the admin opened the "+ Create new company" input but didn't
    // type anything, that's almost certainly an oversight. Block save.
    if (showNewCompanyInput && newCompanyDraft.trim().length === 0) {
      setToast({ type: 'error', message: 'Enter a company name or pick an existing one' })
      return
    }

    setSaving(true)

    // ── Resolve company_id ─────────────────────────────────────────────
    // If the user typed a brand-new company name in the inline input we
    // upsert it first (unique constraint on `name` makes this safe), then
    // assign the resulting id to the account.
    let resolvedCompanyId: string | null = modalForm.company_id
    const newName = newCompanyDraft.trim()
    if (showNewCompanyInput && newName.length > 0) {
      const { data: upserted, error: upsertErr } = await supabase
        .from('companies')
        .upsert({ name: newName }, { onConflict: 'name' })
        .select('id, name, created_at')
        .single()
      if (upsertErr || !upserted) {
        setSaving(false)
        setToast({ type: 'error', message: `Failed to create company: ${upsertErr?.message ?? 'unknown error'}` })
        return
      }
      resolvedCompanyId = upserted.id as string
      // Add to local list so the dropdown reflects it without a refetch.
      setCompanies((prev) => {
        if (prev.some((c) => c.id === upserted.id)) return prev
        return [...prev, upserted as Company].sort((a, b) => a.name.localeCompare(b.name))
      })
    }

    // Final sanitize of the allowlist on save. Trim, lowercase, drop empties,
    // dedupe, and cap at SPAM_ALLOWLIST_MAX entries to prevent abuse.
    const cleanedAllowlist = Array.from(
      new Set(
        (modalForm.spam_allowlist || [])
          .map(normalizeAllowlistEntry)
          .filter((v): v is string => v !== null)
      )
    ).slice(0, SPAM_ALLOWLIST_MAX)

    const fields = {
      company_id: resolvedCompanyId,
      ai_auto_reply: modalForm.ai_auto_reply,
      ai_trust_mode: modalForm.ai_trust_mode,
      ai_confidence_threshold: modalForm.ai_confidence_threshold,
      working_hours_start: modalForm.working_hours_start,
      working_hours_end: modalForm.working_hours_end,
      working_timezone: modalForm.working_timezone,
      ai_system_prompt: modalForm.ai_system_prompt || null,
      sla_warning_hours: modalForm.sla_warning_hours,
      sla_critical_hours: modalForm.sla_critical_hours,
      sla_auto_escalate: modalForm.sla_auto_escalate,
      spam_detection_enabled: modalForm.spam_detection_enabled,
      spam_allowlist: cleanedAllowlist,
      monthly_ai_budget_usd: Math.max(0, Number(modalForm.monthly_ai_budget_usd) || 0),
      ai_budget_alert_at_pct: Math.min(
        99,
        Math.max(1, Math.round(Number(modalForm.ai_budget_alert_at_pct) || 90))
      ),
    }
    const saved = await saveField(fields)
    setSaving(false)
    if (saved) {
      // Reflect the sanitized allowlist + resolved company back into the form
      setModalForm((prev) =>
        prev
          ? { ...prev, spam_allowlist: cleanedAllowlist, company_id: resolvedCompanyId }
          : prev
      )
      setShowNewCompanyInput(false)
      setNewCompanyDraft('')
      setToast({ type: 'success', message: 'Account settings saved successfully' })
    }
  }, [detailAccount, modalForm, saveField, supabase, newCompanyDraft, showNewCompanyInput])

  // Add a new substring to the allowlist. Dedup, trim, lowercase, enforce cap.
  const addAllowlistEntry = useCallback(() => {
    if (!modalForm) return
    const next = normalizeAllowlistEntry(allowlistDraft)
    if (!next) {
      setAllowlistDraft('')
      return
    }
    if (modalForm.spam_allowlist.includes(next)) {
      setAllowlistDraft('')
      return
    }
    if (modalForm.spam_allowlist.length >= SPAM_ALLOWLIST_MAX) {
      setToast({
        type: 'error',
        message: `Allowlist limited to ${SPAM_ALLOWLIST_MAX} entries`,
      })
      return
    }
    setModalForm((prev) =>
      prev ? { ...prev, spam_allowlist: [...prev.spam_allowlist, next] } : prev
    )
    setAllowlistDraft('')
  }, [allowlistDraft, modalForm])

  // Save OOO config via the dedicated API. Separate from the bulk
  // saveAccountSettings flow because OOO is auth-gated more strictly
  // (company_admin / super_admin only) and surfaces validation errors
  // distinctly (bad date range, etc.).
  const saveOOO = useCallback(async () => {
    if (!detailAccount || !modalForm) return
    setSaving(true)
    try {
      const payload = {
        ooo_enabled: modalForm.ooo_enabled,
        ooo_starts_at: datetimeLocalToIso(modalForm.ooo_starts_at),
        ooo_ends_at: datetimeLocalToIso(modalForm.ooo_ends_at),
        ooo_subject: modalForm.ooo_subject || null,
        ooo_body: modalForm.ooo_body || null,
      }
      const res = await fetch(`/api/accounts/${detailAccount.id}/ooo`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = (await res.json().catch(() => null)) as
        | { ooo?: { ooo_enabled: boolean; ooo_starts_at: string | null; ooo_ends_at: string | null; ooo_subject: string | null; ooo_body: string | null }; error?: string }
        | null
      if (!res.ok) {
        setToast({ type: 'error', message: json?.error || `Failed to save OOO (${res.status})` })
        return
      }
      // Reflect server-canonical values into local state so banner / badge
      // stay accurate without a refetch.
      const ooo = json?.ooo
      if (ooo) {
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === detailAccount.id
              ? {
                  ...a,
                  ooo_enabled: ooo.ooo_enabled,
                  ooo_starts_at: ooo.ooo_starts_at,
                  ooo_ends_at: ooo.ooo_ends_at,
                  ooo_subject: ooo.ooo_subject,
                  ooo_body: ooo.ooo_body,
                }
              : a
          )
        )
        setDetailAccount((prev) =>
          prev
            ? {
                ...prev,
                ooo_enabled: ooo.ooo_enabled,
                ooo_starts_at: ooo.ooo_starts_at,
                ooo_ends_at: ooo.ooo_ends_at,
                ooo_subject: ooo.ooo_subject,
                ooo_body: ooo.ooo_body,
              }
            : null
        )
      }
      setToast({ type: 'success', message: 'Out-of-office settings saved' })
    } finally {
      setSaving(false)
    }
  }, [detailAccount, modalForm])

  const removeAllowlistEntry = useCallback((entry: string) => {
    setModalForm((prev) =>
      prev
        ? { ...prev, spam_allowlist: prev.spam_allowlist.filter((e) => e !== entry) }
        : prev
    )
  }, [])

  // Fetch accounts from Supabase
  useEffect(() => {
    async function fetchAccounts() {
      setLoading(true)
      setError(null)
      const { data, error: fetchError } = await supabase
        .from('accounts')
        .select('*')
        .order('name', { ascending: true })

      if (fetchError) {
        setError(fetchError.message)
        setLoading(false)
        return
      }

      const mapped: Account[] = (data ?? []) as Account[]

      // Sort: group by base company name, email first then teams
      const channelOrder: Record<string, number> = { email: 0, teams: 1, whatsapp: 2 }
      mapped.sort((a, b) => {
        const baseA = a.name.replace(/\s+Teams$/i, '').trim()
        const baseB = b.name.replace(/\s+Teams$/i, '').trim()
        const nameCmp = baseA.localeCompare(baseB)
        if (nameCmp !== 0) return nameCmp
        return (channelOrder[a.channel_type] ?? 9) - (channelOrder[b.channel_type] ?? 9)
      })

      setAccounts(mapped)
      setLoading(false)
    }
    fetchAccounts()
  }, [])

  const filtered = accounts.filter((a) => {
    if (channelFilter !== 'all' && a.channel_type !== channelFilter) return false
    if (search && !a.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const togglePhase1 = useCallback(async (id: string, value: boolean) => {
    const updates: { phase1_enabled: boolean; phase2_enabled?: boolean } = { phase1_enabled: value }
    if (!value) updates.phase2_enabled = false

    // Capture original values and apply optimistic update in one setter
    let originalPhase1 = false
    let originalPhase2 = false
    setAccounts((prev) =>
      prev.map((a) => {
        if (a.id === id) {
          originalPhase1 = a.phase1_enabled
          originalPhase2 = a.phase2_enabled
          return { ...a, phase1_enabled: value, phase2_enabled: value ? a.phase2_enabled : false }
        }
        return a
      })
    )

    const { error: updateError } = await supabase
      .from('accounts')
      .update(updates)
      .eq('id', id)

    if (updateError) {
      console.error('Failed to update phase1:', updateError.message)
      // Revert BOTH phase1 and phase2 to their original values before the toggle
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === id
            ? { ...a, phase1_enabled: originalPhase1, phase2_enabled: originalPhase2 }
            : a
        )
      )
    }
  }, [])

  const togglePhase2 = useCallback(async (id: string, value: boolean) => {
    // Optimistic update
    setAccounts((prev) =>
      prev.map((a) => (a.id === id ? { ...a, phase2_enabled: value } : a))
    )

    const { error: updateError } = await supabase
      .from('accounts')
      .update({ phase2_enabled: value })
      .eq('id', id)

    if (updateError) {
      console.error('Failed to update phase2:', updateError.message)
      // Revert on failure
      setAccounts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, phase2_enabled: !value } : a))
      )
    }
  }, [])

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map((a) => a.id)))
    }
  }

  const enableMonitorAll = async () => {
    // Optimistic update
    setAccounts((prev) =>
      prev.map((a) => ({ ...a, phase1_enabled: true }))
    )

    const { error: updateError } = await supabase
      .from('accounts')
      .update({ phase1_enabled: true })
      .neq('phase1_enabled', true)

    if (updateError) {
      console.error('Failed to enable monitor all:', updateError.message)
    }
  }

  const enableAIReplySelected = async () => {
    const idsToUpdate = Array.from(selectedIds).filter((id) => {
      const account = accounts.find((a) => a.id === id)
      return account?.phase1_enabled
    })

    // Optimistic update
    setAccounts((prev) =>
      prev.map((a) =>
        selectedIds.has(a.id) && a.phase1_enabled
          ? { ...a, phase2_enabled: true }
          : a
      )
    )

    if (idsToUpdate.length > 0) {
      const { error: updateError } = await supabase
        .from('accounts')
        .update({ phase2_enabled: true })
        .in('id', idsToUpdate)

      if (updateError) {
        console.error('Failed to enable AI reply for selected:', updateError.message)
      }
    }
  }

  const getStatusDot = (a: Account) => {
    if (a.phase1_enabled && a.phase2_enabled) return 'bg-green-500'
    if (a.phase1_enabled) return 'bg-yellow-500'
    return 'bg-gray-400'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        <span className="ml-3 text-gray-500">Loading accounts...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <p className="text-red-600 font-medium">Failed to load accounts</p>
        <p className="text-sm text-gray-500 mt-1">{error}</p>
        <Button variant="secondary" className="mt-4" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Account Management</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage all {accounts.length} connected accounts and their phase settings
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={enableMonitorAll}>
            Enable Monitor All
          </Button>
          <Button
            variant="primary"
            onClick={enableAIReplySelected}
            disabled={selectedIds.size === 0}
          >
            Enable AI Reply for Selected
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <Input
              placeholder="Search accounts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              icon={<Search className="h-4 w-4" />}
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-gray-400" />
            {(['all', 'teams', 'email', 'whatsapp'] as const).map((ch) => (
              <button
                key={ch}
                onClick={() => setChannelFilter(ch)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  channelFilter === ch
                    ? 'bg-teal-100 text-teal-700'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {ch === 'all' ? 'All' : getChannelLabel(ch)}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* Summary badges */}
      <div className="flex items-center gap-4">
        <Badge variant="success">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-green-500" />
          {accounts.filter((a) => a.phase1_enabled && a.phase2_enabled).length} Full System
        </Badge>
        <Badge variant="warning">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-yellow-500" />
          {accounts.filter((a) => a.phase1_enabled && !a.phase2_enabled).length} Monitor Only
        </Badge>
        <Badge variant="default">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-gray-400" />
          {accounts.filter((a) => !a.phase1_enabled).length} Idle
        </Badge>
      </div>

      {/* Accounts table */}
      <Card>
        {filtered.length === 0 ? (
          <EmptyState
            icon={Plug}
            title={accounts.length === 0 ? 'No accounts configured' : 'No accounts found'}
            description={
              accounts.length === 0
                ? 'Connect a Gmail, Microsoft Teams, or WhatsApp Business account to start ingesting customer messages.'
                : 'Try adjusting your search or filter criteria.'
            }
            action={
              accounts.length === 0 ? (
                <a href="/admin/channels">
                  <Button variant="primary">
                    <Plug className="h-4 w-4" />
                    Connect a channel
                  </Button>
                </a>
              ) : undefined
            }
            hint={
              accounts.length === 0
                ? 'You can also import existing accounts via the Companies admin page.'
                : undefined
            }
          />
        ) : (
          <div className="space-y-3">
            {(() => {
              // Group accounts by base company name
              const groups: Record<string, Account[]> = {}
              filtered.forEach((a) => {
                const baseName = a.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
                if (!groups[baseName]) groups[baseName] = []
                groups[baseName].push(a)
              })

              return Object.entries(groups).map(([companyName, channelAccounts]) => (
                <div key={companyName} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                  {/* Company header */}
                  <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-100">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={channelAccounts.every(a => selectedIds.has(a.id))}
                        onChange={() => {
                          const allSelected = channelAccounts.every(a => selectedIds.has(a.id))
                          setSelectedIds(prev => {
                            const next = new Set(prev)
                            channelAccounts.forEach(a => allSelected ? next.delete(a.id) : next.add(a.id))
                            return next
                          })
                        }}
                        className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                      />
                      <span className="text-sm font-bold text-gray-900">{companyName}</span>
                      <div className="flex items-center gap-1.5">
                        {channelAccounts.map(a => (
                          <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                            <ChannelIcon channel={a.channel_type} size={12} />
                            {getChannelLabel(a.channel_type)}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span className="text-xs text-gray-400">
                      {timeAgo(channelAccounts.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0]?.updated_at)}
                    </span>
                  </div>

                  {/* Channel rows */}
                  <div className="divide-y divide-gray-100">
                    {channelAccounts.map((account) => (
                      <div
                        key={account.id}
                        className="flex items-center gap-4 px-5 py-3 hover:bg-teal-50/30 cursor-pointer transition-colors"
                        onClick={() => setDetailAccount(account)}
                      >
                        <div className="flex items-center gap-2 w-32 shrink-0">
                          <span className={`h-2 w-2 rounded-full shrink-0 ${getStatusDot(account)}`} />
                          <ChannelIcon channel={account.channel_type} size={16} />
                          <span className="text-xs font-medium text-gray-700">{getChannelLabel(account.channel_type)}</span>
                          {isAccountOOOActive(account) && (
                            <span
                              className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700"
                              title={`Out of office until ${formatOOOEnd(account.ooo_ends_at)}`}
                            >
                              OOO
                            </span>
                          )}
                        </div>

                        <div className="w-44 min-w-0 shrink-0">
                          <span className="text-xs text-gray-500 truncate block" title={account.gmail_address || ''}>
                            {account.gmail_address || <span className="text-gray-300 italic">No email</span>}
                          </span>
                        </div>

                        <div className="flex items-center gap-6 flex-1" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-gray-400 w-16">Monitor:</span>
                            <Toggle
                              checked={account.phase1_enabled}
                              onChange={(val) => togglePhase1(account.id, val)}
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-gray-400 w-16">AI Reply:</span>
                            <Toggle
                              checked={account.phase2_enabled}
                              onChange={(val) => togglePhase2(account.id, val)}
                              disabled={!account.phase1_enabled}
                            />
                          </div>
                        </div>

                        <PhaseIndicator
                          phase1_enabled={account.phase1_enabled}
                          phase2_enabled={account.phase2_enabled}
                        />

                        <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
                      </div>
                    ))}
                  </div>
                </div>
              ))
            })()}
          </div>
        )}
      </Card>

      {/* Detail Modal */}
      <Modal
        open={!!detailAccount}
        onClose={() => setDetailAccount(null)}
        title={detailAccount ? `${detailAccount.name} Settings` : ''}
        className="sm:max-w-2xl"
      >
        {detailAccount && modalForm && (
          <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
            <div className="flex items-center gap-3">
              <ChannelIcon channel={detailAccount.channel_type} size={24} />
              <div>
                <p className="font-semibold text-gray-900">{detailAccount.name}</p>
                <p className="text-sm text-gray-500">
                  {getChannelLabel(detailAccount.channel_type)} Account
                </p>
                {detailAccount.gmail_address && (
                  <p className="text-xs text-teal-600 mt-0.5">
                    📧 {detailAccount.gmail_address}
                  </p>
                )}
              </div>
            </div>

            {/* Company / Identity */}
            <div className="rounded-lg border border-gray-200 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">Company</h3>
                {modalForm.company_id === null && !showNewCompanyInput && (
                  <span className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    Legacy: company derived from name
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Sibling channel accounts (e.g. an Email + Teams account for the same tenant)
                are grouped by this. Required for new accounts; existing rows fall back to a
                name-prefix match until set.
              </p>

              <select
                value={
                  showNewCompanyInput
                    ? NEW_COMPANY_SENTINEL
                    : (modalForm.company_id ?? '')
                }
                onChange={(e) => {
                  const v = e.target.value
                  if (v === NEW_COMPANY_SENTINEL) {
                    setShowNewCompanyInput(true)
                    return
                  }
                  setShowNewCompanyInput(false)
                  setNewCompanyDraft('')
                  setModalForm((prev) =>
                    prev ? { ...prev, company_id: v === '' ? null : v } : prev
                  )
                }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none bg-white"
              >
                <option value="">— Unassigned (legacy) —</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value={NEW_COMPANY_SENTINEL}>+ Create new company…</option>
              </select>

              {showNewCompanyInput && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newCompanyDraft}
                    onChange={(e) => setNewCompanyDraft(e.target.value)}
                    placeholder="New company name (e.g. Acme Corp)"
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                    autoFocus
                  />
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setShowNewCompanyInput(false)
                      setNewCompanyDraft('')
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>

            {/* Phase Toggles (existing functionality) */}
            <div className="rounded-lg border border-gray-200 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Phase 1 - Monitor</span>
                <Toggle
                  checked={detailAccount.phase1_enabled}
                  onChange={(val) => {
                    togglePhase1(detailAccount.id, val)
                    setDetailAccount((prev) =>
                      prev
                        ? { ...prev, phase1_enabled: val, phase2_enabled: val ? prev.phase2_enabled : false }
                        : null
                    )
                  }}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Phase 2 - AI Reply</span>
                <Toggle
                  checked={detailAccount.phase2_enabled}
                  onChange={(val) => {
                    togglePhase2(detailAccount.id, val)
                    setDetailAccount((prev) =>
                      prev ? { ...prev, phase2_enabled: val } : null
                    )
                  }}
                  disabled={!detailAccount.phase1_enabled}
                />
              </div>
            </div>

            {/* AI Settings */}
            <div className="rounded-lg border border-gray-200 p-4 space-y-4">
              <h3 className="text-sm font-semibold text-gray-900">AI Settings</h3>

              {/* Auto Reply Toggle */}
              <div className="flex items-center justify-between">
                <div className="flex-1 mr-4">
                  <span className="text-sm font-medium text-gray-700">Auto Reply</span>
                  <p className="text-xs text-gray-500 mt-0.5">
                    When enabled, AI will automatically generate reply drafts for incoming messages
                  </p>
                </div>
                <Toggle
                  checked={modalForm.ai_auto_reply}
                  onChange={(val) => toggleField('ai_auto_reply', val)}
                />
              </div>

              {/* Trust Mode Toggle */}
              <div className="flex items-center justify-between">
                <div className="flex-1 mr-4">
                  <span className="text-sm font-medium text-gray-700">Trust Mode</span>
                  <p className="text-xs text-gray-500 mt-0.5">
                    When enabled, AI replies are sent directly without human approval (use with caution)
                  </p>
                </div>
                <Toggle
                  checked={modalForm.ai_trust_mode}
                  onChange={(val) => toggleField('ai_trust_mode', val)}
                />
              </div>

              {/* Confidence Threshold Slider */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-700">Confidence Threshold</span>
                  <span className="text-sm font-semibold text-teal-700">
                    {(modalForm.ai_confidence_threshold * 100).toFixed(0)}%
                  </span>
                </div>
                <p className="text-xs text-gray-500 mb-2">
                  Minimum AI confidence score required for auto-sending replies
                </p>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(modalForm.ai_confidence_threshold * 100)}
                  onChange={(e) =>
                    setModalForm((prev) =>
                      prev ? { ...prev, ai_confidence_threshold: Number(e.target.value) / 100 } : prev
                    )
                  }
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-teal-700"
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>0%</span>
                  <span>50%</span>
                  <span>100%</span>
                </div>
              </div>
            </div>

            {/* Working Hours */}
            <div className="rounded-lg border border-gray-200 p-4 space-y-4">
              <h3 className="text-sm font-semibold text-gray-900">Working Hours</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label>
                  <input
                    type="time"
                    value={modalForm.working_hours_start.slice(0, 5)}
                    onChange={(e) =>
                      setModalForm((prev) =>
                        prev ? { ...prev, working_hours_start: e.target.value + ':00' } : prev
                      )
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">End Time</label>
                  <input
                    type="time"
                    value={modalForm.working_hours_end.slice(0, 5)}
                    onChange={(e) =>
                      setModalForm((prev) =>
                        prev ? { ...prev, working_hours_end: e.target.value + ':00' } : prev
                      )
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
                <select
                  value={modalForm.working_timezone}
                  onChange={(e) =>
                    setModalForm((prev) =>
                      prev ? { ...prev, working_timezone: e.target.value } : prev
                    )
                  }
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none bg-white"
                >
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* AI System Prompt */}
            <div className="rounded-lg border border-gray-200 p-4 space-y-2">
              <h3 className="text-sm font-semibold text-gray-900">AI System Prompt</h3>
              <p className="text-xs text-gray-500">
                Pick a tone preset to start from, or write your own. The text below is what the AI sees before every reply.
              </p>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Tone preset</label>
                <select
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                  onChange={(e) => {
                    const key = e.target.value as keyof typeof AI_TONE_PRESETS | ''
                    if (!key) return
                    const preset = AI_TONE_PRESETS[key]
                    setModalForm((prev) =>
                      prev ? { ...prev, ai_system_prompt: preset } : prev
                    )
                    e.target.value = '' // reset dropdown so re-selecting the same preset still applies
                  }}
                  defaultValue=""
                >
                  <option value="">— Apply a preset —</option>
                  <option value="friendly">Friendly — warm &amp; conversational</option>
                  <option value="formal">Formal — polite &amp; professional</option>
                  <option value="terse">Terse — short &amp; direct</option>
                  <option value="empathetic">Empathetic — validating &amp; patient</option>
                  <option value="sales">Sales — enthusiastic &amp; persuasive</option>
                  <option value="clear">Clear</option>
                </select>
              </div>
              <textarea
                value={modalForm.ai_system_prompt}
                onChange={(e) =>
                  setModalForm((prev) =>
                    prev ? { ...prev, ai_system_prompt: e.target.value } : prev
                  )
                }
                rows={4}
                placeholder="e.g. You are a customer support agent for Acme Corp. Always be polite and professional..."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none resize-y"
              />
            </div>

            {/* AI Cost Budget */}
            {(() => {
              const budget = Number(modalForm.monthly_ai_budget_usd) || 0
              const alertPct = Number(modalForm.ai_budget_alert_at_pct) || 90
              const spent = aiSpendThisMonth ?? 0
              const pct = budget > 0 ? (spent / budget) * 100 : 0
              const pctClamped = Math.min(100, Math.max(0, pct))
              const isOver = budget > 0 && spent >= budget
              const isAmber = !isOver && pct >= alertPct
              // Tailwind 4 — only static class strings, no dynamic interpolation.
              const barClass = isOver
                ? 'bg-red-500'
                : isAmber
                ? 'bg-amber-500'
                : 'bg-green-500'
              const pctTextClass = isOver
                ? 'text-red-700'
                : isAmber
                ? 'text-amber-700'
                : 'text-green-700'
              return (
                <div className="rounded-lg border border-gray-200 p-4 space-y-4">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">AI Cost Budget</h3>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Monthly hard cap on AI spend for this account. Calls are blocked once
                      the cap is hit. Cost is estimated from token counts — coarse but useful
                      for runaway-cost detection.
                    </p>
                  </div>

                  {/* Live readout */}
                  <div className="rounded-md bg-gray-50 border border-gray-100 p-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-600">Spent this month</span>
                      <span className={`font-semibold ${pctTextClass}`}>
                        {aiSpendThisMonth === null ? (
                          <span className="text-gray-400 italic">loading…</span>
                        ) : (
                          <>
                            ${spent.toFixed(4)} / ${budget.toFixed(2)}{' '}
                            <span className="text-xs font-normal text-gray-500">
                              ({pct.toFixed(1)}%)
                            </span>
                          </>
                        )}
                      </span>
                    </div>
                    <div className="mt-2 h-2 w-full rounded-full bg-gray-200 overflow-hidden">
                      <div
                        className={`h-full ${barClass} transition-all`}
                        style={{ width: `${pctClamped}%` }}
                      />
                    </div>
                    {isOver && (
                      <p className="mt-2 text-xs font-medium text-red-700">
                        Budget reached — new AI calls will be skipped until next month.
                      </p>
                    )}
                    {!isOver && isAmber && (
                      <p className="mt-2 text-xs font-medium text-amber-700">
                        Past the {alertPct}% alert threshold.
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Monthly budget (USD)
                      </label>
                      <p className="text-xs text-gray-500 mb-1.5">
                        Default $50. Set to 0 to disable the cap.
                      </p>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={modalForm.monthly_ai_budget_usd}
                        onChange={(e) =>
                          setModalForm((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  monthly_ai_budget_usd: Math.max(0, Number(e.target.value) || 0),
                                }
                              : prev
                          )
                        }
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Alert threshold (%)
                      </label>
                      <p className="text-xs text-gray-500 mb-1.5">
                        Audit alert fires when spend crosses this % of budget.
                      </p>
                      <input
                        type="number"
                        min={1}
                        max={99}
                        step={1}
                        value={modalForm.ai_budget_alert_at_pct}
                        onChange={(e) =>
                          setModalForm((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  ai_budget_alert_at_pct: Math.min(
                                    99,
                                    Math.max(1, Math.round(Number(e.target.value) || 90))
                                  ),
                                }
                              : prev
                          )
                        }
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* SLA Settings */}
            <div className="rounded-lg border border-gray-200 p-4 space-y-4">
              <h3 className="text-sm font-semibold text-gray-900">SLA Settings</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Warning Threshold (hours)
                  </label>
                  <p className="text-xs text-gray-500 mb-1.5">
                    Messages waiting longer turn amber
                  </p>
                  <input
                    type="number"
                    min={1}
                    max={72}
                    value={modalForm.sla_warning_hours}
                    onChange={(e) =>
                      setModalForm((prev) =>
                        prev ? { ...prev, sla_warning_hours: Math.max(1, Number(e.target.value)) } : prev
                      )
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Critical Threshold (hours)
                  </label>
                  <p className="text-xs text-gray-500 mb-1.5">
                    Messages waiting longer turn red (SLA breached)
                  </p>
                  <input
                    type="number"
                    min={1}
                    max={168}
                    value={modalForm.sla_critical_hours}
                    onChange={(e) =>
                      setModalForm((prev) =>
                        prev ? { ...prev, sla_critical_hours: Math.max(1, Number(e.target.value)) } : prev
                      )
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex-1 mr-4">
                  <span className="text-sm font-medium text-gray-700">Auto-Escalate</span>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Automatically escalate conversations that breach the SLA critical threshold
                  </p>
                </div>
                <Toggle
                  checked={modalForm.sla_auto_escalate}
                  onChange={(val) => toggleField('sla_auto_escalate', val)}
                />
              </div>
            </div>

            {/* Out of Office */}
            <div className="rounded-lg border border-gray-200 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Out of Office</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    When enabled and inside the window, every new conversation receives an
                    automatic reply (once per OOO window). The original message still routes
                    normally so you see it when you're back.
                  </p>
                </div>
                <Toggle
                  checked={modalForm.ooo_enabled}
                  onChange={(val) =>
                    setModalForm((prev) => (prev ? { ...prev, ooo_enabled: val } : prev))
                  }
                />
              </div>

              {/* Active banner */}
              {detailAccount.ooo_enabled && isAccountOOOActive(detailAccount) && (
                <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs font-medium text-amber-800">
                  Out of office until {formatOOOEnd(detailAccount.ooo_ends_at)} — auto-replies enabled
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start</label>
                  <input
                    type="datetime-local"
                    value={modalForm.ooo_starts_at}
                    onChange={(e) =>
                      setModalForm((prev) =>
                        prev ? { ...prev, ooo_starts_at: e.target.value } : prev
                      )
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">Leave blank to start immediately.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">End</label>
                  <input
                    type="datetime-local"
                    value={modalForm.ooo_ends_at}
                    onChange={(e) =>
                      setModalForm((prev) =>
                        prev ? { ...prev, ooo_ends_at: e.target.value } : prev
                      )
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">Leave blank for no scheduled return.</p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
                <Input
                  value={modalForm.ooo_subject}
                  onChange={(e) =>
                    setModalForm((prev) =>
                      prev ? { ...prev, ooo_subject: e.target.value } : prev
                    )
                  }
                  placeholder="Out of office"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Body</label>
                <textarea
                  value={modalForm.ooo_body}
                  onChange={(e) =>
                    setModalForm((prev) =>
                      prev ? { ...prev, ooo_body: e.target.value } : prev
                    )
                  }
                  rows={5}
                  placeholder="Hi {{customer.name}}, I'm currently out of office and will respond when I return on {{ooo.return_date}}. — {{company.name}}"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none resize-y font-mono"
                />
                <p className="text-[11px] text-gray-500 mt-1">
                  Variables: <code className="rounded bg-gray-100 px-1">{`{{customer.name}}`}</code>{' '}
                  <code className="rounded bg-gray-100 px-1">{`{{ooo.return_date}}`}</code>{' '}
                  <code className="rounded bg-gray-100 px-1">{`{{company.name}}`}</code>
                </p>
              </div>

              <div className="pt-1">
                <Button
                  variant="primary"
                  onClick={saveOOO}
                  loading={saving}
                  className="w-full sm:w-auto"
                >
                  {saving ? 'Saving…' : 'Save out-of-office'}
                </Button>
              </div>
            </div>

            {/* Spam Detection */}
            <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-4 shadow-sm">
              <div>
                <h3 className="text-[11px] uppercase tracking-wider font-semibold text-gray-500">
                  Spam detection
                </h3>
                <p className="text-xs text-gray-500 mt-1">
                  Per-account overrides for the global spam filter. Useful for accounts whose
                  customers legitimately email from noreply/notifications addresses.
                </p>
              </div>

              {/* Enable toggle */}
              <div className="flex items-center justify-between">
                <div className="flex-1 mr-4">
                  <span className="text-sm font-medium text-gray-700">Enable spam detection</span>
                  <p className="text-xs text-gray-500 mt-0.5">
                    When off, every inbound is treated as real mail for this account. Turn off for
                    accounts whose customers legitimately send from noreply/notifications addresses
                    (banks, carriers, automated platforms).
                  </p>
                </div>
                <Toggle
                  checked={modalForm.spam_detection_enabled}
                  onChange={(val) =>
                    setModalForm((prev) =>
                      prev ? { ...prev, spam_detection_enabled: val } : prev
                    )
                  }
                />
              </div>

              {/* Sender allowlist */}
              <div>
                <label className="block text-[11px] uppercase tracking-wider font-semibold text-gray-500 mb-1">
                  Sender allowlist
                </label>
                <p className="text-xs text-gray-500 mb-2">
                  Senders containing any of these substrings will NEVER be flagged as spam, even
                  if other rules match. Case-insensitive. e.g. <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px]">notifications@mybank.com</code>, <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px]">@carriersupport.com</code>
                </p>

                {/* Chip list */}
                {modalForm.spam_allowlist.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {modalForm.spam_allowlist.map((entry) => (
                      <span
                        key={entry}
                        className="inline-flex items-center gap-1 rounded-full bg-teal-50 border border-teal-200 px-2.5 py-1 text-xs font-medium text-teal-800"
                      >
                        {entry}
                        <button
                          type="button"
                          onClick={() => removeAllowlistEntry(entry)}
                          className="rounded-full p-0.5 text-teal-500 hover:bg-teal-100 hover:text-teal-700 transition-colors"
                          aria-label={`Remove ${entry}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 italic mb-2">No allowlist entries.</p>
                )}

                {/* Add input */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={allowlistDraft}
                    onChange={(e) => setAllowlistDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addAllowlistEntry()
                      }
                    }}
                    placeholder="e.g. notifications@mybank.com"
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                  />
                  <Button
                    variant="secondary"
                    onClick={addAllowlistEntry}
                    disabled={
                      !allowlistDraft.trim() ||
                      modalForm.spam_allowlist.length >= SPAM_ALLOWLIST_MAX
                    }
                  >
                    Add
                  </Button>
                </div>
                <p className="text-[11px] text-gray-400 mt-1.5">
                  {modalForm.spam_allowlist.length} / {SPAM_ALLOWLIST_MAX} entries
                </p>
              </div>
            </div>

            {/* Info row */}
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>Last updated: {timeAgo(detailAccount.updated_at)}</span>
            </div>

            {/* Save Button */}
            <div className="pt-2 border-t border-gray-100">
              <Button
                variant="primary"
                className="w-full"
                onClick={saveAccountSettings}
                loading={saving}
              >
                {saving ? 'Saving...' : 'Save Settings'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] animate-in slide-in-from-bottom-4 fade-in duration-300">
          <div
            className={`flex items-center gap-2 rounded-lg px-4 py-3 shadow-lg text-sm font-medium ${
              toast.type === 'success'
                ? 'bg-green-600 text-white'
                : 'bg-red-600 text-white'
            }`}
          >
            {toast.type === 'success' ? (
              <Check className="h-4 w-4" />
            ) : (
              <AlertCircle className="h-4 w-4" />
            )}
            {toast.message}
          </div>
        </div>
      )}
    </div>
  )
}
