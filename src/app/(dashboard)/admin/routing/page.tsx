'use client'

// Admin: Routing Rules
// Manage `routing_rules` — name, conditions DSL, actions (priority/status/
// tags/assignment). Saves go through /api/routing-rules (admin-gated).

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase-client'
import { useUser } from '@/context/user-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Modal } from '@/components/ui/modal'
import { Toggle } from '@/components/ui/toggle'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm-dialog'
import {
  GitBranch,
  Plus,
  Trash2,
  Edit2,
  Loader2,
  X,
  Tag,
  UserCheck,
} from 'lucide-react'

type FieldKey =
  | 'channel'
  | 'account_id'
  | 'sender_email'
  | 'sender_phone'
  | 'subject'
  | 'body'
  | 'sentiment'
  | 'category'

type OpKey = 'equals' | 'contains' | 'starts_with' | 'ends_with' | 'matches_regex' | 'in'

interface Condition {
  field: FieldKey | string
  op: OpKey | string
  value: unknown
}

interface RoutingRule {
  id: string
  name: string
  is_active: boolean
  priority: number
  conditions: Condition[]
  match_mode: 'all' | 'any'
  set_priority: string | null
  set_status: string | null
  add_tags: string[] | null
  assign_to_team: string | null
  assign_to_user: string | null
  use_round_robin: boolean
  account_id: string | null
}

interface AccountRow {
  id: string
  name: string
}
interface UserRow {
  id: string
  email: string
  full_name: string | null
}

const FIELD_OPTIONS: { value: FieldKey; label: string }[] = [
  { value: 'channel', label: 'Channel' },
  { value: 'sender_email', label: 'Sender Email' },
  { value: 'sender_phone', label: 'Sender Phone' },
  { value: 'subject', label: 'Subject' },
  { value: 'body', label: 'Message Body' },
  { value: 'sentiment', label: 'Sentiment' },
  { value: 'category', label: 'Category' },
  { value: 'account_id', label: 'Account ID' },
]

// Per-field operator allowlist. Most fields support all string ops; a few
// (channel, sentiment, category) are best with equals / in.
function opsForField(field: string): { value: OpKey; label: string }[] {
  if (field === 'channel' || field === 'sentiment') {
    return [
      { value: 'equals', label: 'equals' },
      { value: 'in', label: 'is one of' },
    ]
  }
  if (field === 'category') {
    return [
      { value: 'equals', label: 'equals' },
      { value: 'in', label: 'is one of' },
      { value: 'contains', label: 'contains' },
    ]
  }
  return [
    { value: 'equals', label: 'equals' },
    { value: 'contains', label: 'contains' },
    { value: 'starts_with', label: 'starts with' },
    { value: 'ends_with', label: 'ends with' },
    { value: 'matches_regex', label: 'matches regex' },
    { value: 'in', label: 'is one of (comma-sep)' },
  ]
}

const PRIORITY_OPTIONS = [
  { value: '', label: '— no change —' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

const STATUS_OPTIONS = [
  { value: '', label: '— no change —' },
  { value: 'active', label: 'Active' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'waiting_on_customer', label: 'Waiting on Customer' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'resolved', label: 'Resolved' },
]

const emptyForm = (): RoutingRule => ({
  id: '',
  name: '',
  is_active: true,
  priority: 100,
  conditions: [{ field: 'channel', op: 'equals', value: 'email' }],
  match_mode: 'all',
  set_priority: null,
  set_status: null,
  add_tags: null,
  assign_to_team: null,
  assign_to_user: null,
  use_round_robin: false,
  account_id: null,
})

function summarizeConditions(rule: RoutingRule): string {
  if (!rule.conditions || rule.conditions.length === 0) return 'matches all'
  const joiner = rule.match_mode === 'any' ? ' OR ' : ' AND '
  return rule.conditions
    .map((c) => {
      const v = Array.isArray(c.value) ? c.value.join(',') : String(c.value ?? '')
      return `${c.field} ${c.op} "${v}"`
    })
    .join(joiner)
}

function summarizeActions(rule: RoutingRule): string {
  const bits: string[] = []
  if (rule.set_priority) bits.push(`priority=${rule.set_priority}`)
  if (rule.set_status) bits.push(`status=${rule.set_status}`)
  if (rule.add_tags && rule.add_tags.length > 0) bits.push(`+tags[${rule.add_tags.join(',')}]`)
  if (rule.assign_to_user) bits.push(`assign=user`)
  else if (rule.use_round_robin) bits.push(`assign=round-robin${rule.assign_to_team ? `(team:${rule.assign_to_team})` : ''}`)
  else if (rule.assign_to_team) bits.push(`team=${rule.assign_to_team}`)
  return bits.length ? bits.join(' • ') : '— no actions —'
}

export default function RoutingRulesPage() {
  const supabase = createClient()
  const { toast } = useToast()
  const confirm = useConfirm()
  // Active-tenant scope for the "Applies to" (accounts) and "Assign to user"
  // dropdowns. null activeCompanyId = super_admin combined view (unscoped).
  const { activeCompanyId, companyAccountIds } = useUser()

  const [rules, setRules] = useState<RoutingRule[]>([])
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<RoutingRule | null>(null)
  const [form, setForm] = useState<RoutingRule>(emptyForm())
  const [tagsInput, setTagsInput] = useState('')

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      // Scope accounts ("Applies to") and users ("Assign to user") to the
      // active tenant. Combined view (activeCompanyId === null) stays
      // unscoped; accounts filter by id, users by company_id.
      let acctQuery = supabase.from('accounts').select('id, name').order('name')
      if (activeCompanyId) acctQuery = acctQuery.in('id', companyAccountIds)
      let usersQuery = supabase
        .from('users')
        .select('id, email, full_name')
        .eq('is_active', true)
        .order('email')
      if (activeCompanyId) usersQuery = usersQuery.eq('company_id', activeCompanyId)

      const [rulesRes, acctRes, usersRes] = await Promise.all([
        fetch('/api/routing-rules', { cache: 'no-store' }),
        acctQuery,
        usersQuery,
      ])
      if (rulesRes.ok) {
        const j = await rulesRes.json()
        setRules((j.rules || []) as RoutingRule[])
      } else {
        const j = await rulesRes.json().catch(() => ({}))
        toast.error(`Failed to load rules: ${j.error || rulesRes.status}`)
      }
      if (!acctRes.error && acctRes.data) setAccounts(acctRes.data as AccountRow[])
      if (!usersRes.error && usersRes.data) setUsers(usersRes.data as UserRow[])
    } catch (err) {
      toast.error(`Failed to load: ${err instanceof Error ? err.message : 'unknown'}`)
    }
    setLoading(false)
  }, [supabase, toast, activeCompanyId, companyAccountIds])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const openAdd = () => {
    setEditing(null)
    setForm(emptyForm())
    setTagsInput('')
    setShowModal(true)
  }

  const openEdit = (rule: RoutingRule) => {
    setEditing(rule)
    setForm({ ...rule, conditions: Array.isArray(rule.conditions) ? rule.conditions : [] })
    setTagsInput((rule.add_tags || []).join(', '))
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Name is required')
      return
    }
    setSaving(true)
    const tags = tagsInput
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    // Normalize "in" operator values: split comma-separated strings into arrays.
    const normalizedConds = form.conditions.map((c) => {
      if (c.op === 'in' && typeof c.value === 'string') {
        return {
          ...c,
          value: c.value.split(',').map((s) => s.trim()).filter(Boolean),
        }
      }
      return c
    })

    const body = {
      name: form.name,
      is_active: form.is_active,
      priority: form.priority,
      conditions: normalizedConds,
      match_mode: form.match_mode,
      set_priority: form.set_priority || null,
      set_status: form.set_status || null,
      add_tags: tags.length > 0 ? tags : null,
      assign_to_team: form.assign_to_team || null,
      assign_to_user: form.assign_to_user || null,
      use_round_robin: !!form.use_round_robin,
      account_id: form.account_id || null,
    }

    try {
      const res = editing
        ? await fetch(`/api/routing-rules?id=${editing.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetch('/api/routing-rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(`Save failed: ${j.error || res.status}`)
        setSaving(false)
        return
      }
      toast.success(editing ? 'Rule updated' : 'Rule created')
      setShowModal(false)
      await loadAll()
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : 'unknown'}`)
    }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete rule', message: 'Delete this routing rule?', danger: true }))) return
    const res = await fetch(`/api/routing-rules?id=${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      toast.error(`Delete failed: ${j.error || res.status}`)
      return
    }
    toast.success('Rule deleted')
    setRules((prev) => prev.filter((r) => r.id !== id))
  }

  const toggleActive = async (rule: RoutingRule) => {
    const next = !rule.is_active
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, is_active: next } : r)))
    const res = await fetch(`/api/routing-rules?id=${rule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: next }),
    })
    if (!res.ok) {
      // revert
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, is_active: !next } : r)))
      toast.error('Failed to toggle rule')
    }
  }

  const updateCondition = (idx: number, patch: Partial<Condition>) => {
    setForm((f) => ({
      ...f,
      conditions: f.conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }))
  }

  const addCondition = () => {
    setForm((f) => ({
      ...f,
      conditions: [...f.conditions, { field: 'subject', op: 'contains', value: '' }],
    }))
  }

  const removeCondition = (idx: number) => {
    setForm((f) => ({ ...f, conditions: f.conditions.filter((_, i) => i !== idx) }))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        <span className="ml-3 text-gray-500">Loading routing rules…</span>
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Routing Rules</h1>
          <p className="mt-1 text-sm text-gray-500">
            Auto-tag, prioritize, and assign inbound conversations based on conditions.
          </p>
        </div>
        <Button onClick={openAdd}>
          <Plus className="h-4 w-4" /> Add rule
        </Button>
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-700 ring-1 ring-teal-200">
          <GitBranch className="h-3.5 w-3.5" />
          {rules.length} total
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
          {rules.filter((r) => r.is_active).length} active
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 ring-1 ring-violet-200">
          {rules.filter((r) => r.use_round_robin).length} round-robin
        </span>
      </div>

      {/* Rules table */}
      <div className="rounded-2xl border border-gray-200/80 bg-white p-1 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
        {rules.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-500">
            <GitBranch className="h-8 w-8 text-gray-300 mb-2" />
            <p className="font-medium text-gray-700">No routing rules yet</p>
            <p className="text-sm mt-1">Inbound messages will use system defaults until you add a rule.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Conditions</TableHead>
                <TableHead>Actions</TableHead>
                <TableHead className="text-right">Edit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <GitBranch className="h-4 w-4 text-gray-400" />
                      <span className="font-medium text-gray-900">{rule.name}</span>
                      {rule.account_id && (
                        <span className="rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-blue-200">
                          scoped
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <button
                      onClick={() => toggleActive(rule)}
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                        rule.is_active
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {rule.is_active ? 'On' : 'Off'}
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-gray-700">{rule.priority}</TableCell>
                  <TableCell className="max-w-md text-xs text-gray-600">
                    <span className="line-clamp-2">{summarizeConditions(rule)}</span>
                  </TableCell>
                  <TableCell className="max-w-md text-xs text-gray-600">
                    <span className="line-clamp-2">{summarizeActions(rule)}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        onClick={() => openEdit(rule)}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                        title="Edit"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(rule.id)}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Add/Edit modal */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={editing ? 'Edit routing rule' : 'New routing rule'}
        className="sm:max-w-2xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={!form.name.trim()}>
              {editing ? 'Update rule' : 'Create rule'}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          {/* Name + active + priority */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Input
                label="Rule name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g., VIP customers → urgent"
              />
            </div>
            <Input
              label="Priority"
              type="number"
              value={String(form.priority)}
              onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value) || 100 })}
            />
          </div>

          <div className="flex items-center gap-6">
            <Toggle
              checked={form.is_active}
              onChange={(v) => setForm({ ...form, is_active: v })}
              label="Active"
              description="Disabled rules are stored but skipped"
            />
          </div>

          {/* Account scope */}
          <Select
            label="Applies to"
            value={form.account_id || ''}
            onChange={(e) => setForm({ ...form, account_id: e.target.value || null })}
            options={[
              { value: '', label: 'All accounts (global)' },
              ...accounts.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />

          {/* Conditions */}
          <div className="rounded-2xl border border-gray-200/80 bg-gray-50/50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Conditions
              </p>
              <div className="flex items-center gap-3 text-xs">
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={form.match_mode === 'all'}
                    onChange={() => setForm({ ...form, match_mode: 'all' })}
                    className="h-3.5 w-3.5 text-teal-600"
                  />
                  Match all
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={form.match_mode === 'any'}
                    onChange={() => setForm({ ...form, match_mode: 'any' })}
                    className="h-3.5 w-3.5 text-teal-600"
                  />
                  Match any
                </label>
              </div>
            </div>

            <div className="space-y-2">
              {form.conditions.map((c, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-2 ring-1 ring-gray-100"
                >
                  <div className="flex-1">
                    <Select
                      value={String(c.field)}
                      onChange={(e) => updateCondition(idx, { field: e.target.value, op: opsForField(e.target.value)[0]?.value || 'equals' })}
                      options={FIELD_OPTIONS}
                    />
                  </div>
                  <div className="w-40">
                    <Select
                      value={String(c.op)}
                      onChange={(e) => updateCondition(idx, { op: e.target.value })}
                      options={opsForField(String(c.field))}
                    />
                  </div>
                  <div className="flex-1">
                    <Input
                      value={Array.isArray(c.value) ? (c.value as unknown[]).join(', ') : String(c.value ?? '')}
                      onChange={(e) => updateCondition(idx, { value: e.target.value })}
                      placeholder={c.op === 'in' ? 'a, b, c' : 'value'}
                    />
                  </div>
                  <button
                    onClick={() => removeCondition(idx)}
                    className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                    title="Remove"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={addCondition}
              className="mt-2 inline-flex items-center gap-1 rounded-full bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-700 ring-1 ring-teal-200 transition-colors hover:bg-teal-100"
            >
              <Plus className="h-3.5 w-3.5" /> Add condition
            </button>
          </div>

          {/* Actions */}
          <div className="rounded-2xl border border-gray-200/80 bg-gray-50/50 p-4 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Actions
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                label="Set priority"
                value={form.set_priority || ''}
                onChange={(e) => setForm({ ...form, set_priority: e.target.value || null })}
                options={PRIORITY_OPTIONS}
              />
              <Select
                label="Set status"
                value={form.set_status || ''}
                onChange={(e) => setForm({ ...form, set_status: e.target.value || null })}
                options={STATUS_OPTIONS}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                <Tag className="mr-1 inline h-3.5 w-3.5" />
                Add tags (comma-separated)
              </label>
              <Input
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="vip, escalation"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                label="Assign to user"
                value={form.assign_to_user || ''}
                onChange={(e) =>
                  setForm({ ...form, assign_to_user: e.target.value || null })
                }
                options={[
                  { value: '', label: '— none —' },
                  ...users.map((u) => ({
                    value: u.id,
                    label: u.full_name ? `${u.full_name} (${u.email})` : u.email,
                  })),
                ]}
              />
              <Input
                label="Or team name"
                value={form.assign_to_team || ''}
                onChange={(e) => setForm({ ...form, assign_to_team: e.target.value || null })}
                placeholder="billing, support"
              />
            </div>

            <div className="flex items-start gap-2">
              <UserCheck className="mt-1 h-4 w-4 text-gray-500" />
              <Toggle
                checked={form.use_round_robin}
                onChange={(v) => setForm({ ...form, use_round_robin: v })}
                label="Round-robin within team / account"
                description="When on, the rule picks the next least-loaded agent (cycling pointer in assignment_state)."
              />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
