'use client'

import { useState, useCallback, useEffect } from 'react'
import { createClient } from '@/lib/supabase-client'
import type { Account } from '@/types/database'
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
import { Search, Filter, ChevronRight, Loader2, Check, AlertCircle } from 'lucide-react'

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

interface ModalFormState {
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
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // Initialize modal form when detailAccount changes
  useEffect(() => {
    if (detailAccount) {
      setModalForm({
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
      })
    } else {
      setModalForm(null)
    }
  }, [detailAccount])

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3500)
      return () => clearTimeout(timer)
    }
  }, [toast])

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
    setSaving(true)
    const fields = {
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
    }
    const saved = await saveField(fields)
    setSaving(false)
    if (saved) {
      setToast({ type: 'success', message: 'Account settings saved successfully' })
    }
  }, [detailAccount, modalForm, saveField])

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

      // Map DB field make_scenario_id -> n8n_workflow_id for the Account type
      const mapped: Account[] = (data ?? []).map((row: Record<string, unknown>) => ({
        ...row,
        n8n_workflow_id: row.make_scenario_id ?? null,
      })) as Account[]

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
          <div className="flex flex-col items-center justify-center py-12 text-gray-500">
            <p className="font-medium text-gray-700">No accounts found</p>
            <p className="text-sm mt-1">
              {accounts.length === 0
                ? 'No accounts have been configured yet.'
                : 'Try adjusting your search or filter criteria.'}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <input
                    type="checkbox"
                    checked={selectedIds.size === filtered.length && filtered.length > 0}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                  />
                </TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Account Name</TableHead>
                <TableHead>Monitor (Phase 1)</TableHead>
                <TableHead>AI Reply (Phase 2)</TableHead>
                <TableHead>Phase Status</TableHead>
                <TableHead>Last Activity</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((account) => (
                <TableRow
                  key={account.id}
                  className="cursor-pointer"
                  onClick={() => setDetailAccount(account)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(account.id)}
                      onChange={() => toggleSelect(account.id)}
                      className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                    />
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${getStatusDot(account)}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <ChannelIcon channel={account.channel_type} size={16} />
                      <span className="text-xs text-gray-500">
                        {getChannelLabel(account.channel_type)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="font-medium text-gray-900">{account.name}</span>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Toggle
                      checked={account.phase1_enabled}
                      onChange={(val) => togglePhase1(account.id, val)}
                    />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Toggle
                      checked={account.phase2_enabled}
                      onChange={(val) => togglePhase2(account.id, val)}
                      disabled={!account.phase1_enabled}
                    />
                  </TableCell>
                  <TableCell>
                    <PhaseIndicator
                      phase1_enabled={account.phase1_enabled}
                      phase2_enabled={account.phase2_enabled}
                    />
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-gray-500">{timeAgo(account.updated_at)}</span>
                  </TableCell>
                  <TableCell>
                    <ChevronRight className="h-4 w-4 text-gray-400" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
              </div>
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
                Custom instructions for the AI when generating replies for this account
              </p>
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

            {/* Info row */}
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>n8n Workflow: {detailAccount.n8n_workflow_id || 'None'}</span>
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
