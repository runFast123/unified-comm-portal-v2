'use client'

// Admin: Workflow Macros
//
// Create / edit / delete the company's saved macros — reusable bundles of
// one-click conversation actions (set status, add tags, assign, set priority,
// queue a reply template for insertion). Agents RUN these from the conversation
// actions via <MacroRunner>; this page is where admins author them.
//
// A macro NEVER sends a message — it only sets status / tags / assignee /
// priority. Saves go through /api/macros (POST) and /api/macros/[id]
// (PATCH/DELETE), all admin-gated server-side. The route guard in
// `../layout.tsx` already blocks non-admins from reaching this page.
//
// Mirrors the structure of the Routing Rules admin page: a table with an
// add/edit modal, tenant-scoped via the company switcher (activeCompanyId).

import { useState, useEffect, useCallback, useMemo } from 'react'

import { createClient } from '@/lib/supabase-client'
import { useUser } from '@/context/user-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Modal } from '@/components/ui/modal'
import { Toggle } from '@/components/ui/toggle'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import type { MacroActions } from '@/lib/macros'
import {
  type MacroFormState,
  UNASSIGN_VALUE,
  emptyMacroForm,
  actionsToForm,
  buildMacroActions,
  summarizeMacroActions,
} from '@/lib/macro-form'
import {
  Zap,
  Plus,
  Trash2,
  Edit2,
  Loader2,
  Tag,
  CheckCircle2,
} from 'lucide-react'

interface Macro {
  id: string
  company_id: string
  name: string
  description: string | null
  actions: MacroActions | null
  is_active: boolean
}

interface StatusRow {
  id: string
  name: string
}
interface TagRow {
  id: string
  name: string
  color: string
}
interface UserRow {
  id: string
  email: string
  full_name: string | null
}
interface TemplateRow {
  id: string
  title: string
}

const PRIORITY_OPTIONS = [
  { value: '', label: '— no change —' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

export default function MacrosPage() {
  const supabase = createClient()
  const { toast } = useToast()
  // Tenant scope: super_admin uses the company switcher (activeCompanyId) so
  // reads/writes target the viewed tenant. company_admins are pinned to their
  // own company server-side, so activeCompanyId is a no-op for them.
  const { activeCompanyId } = useUser()

  const [macros, setMacros] = useState<Macro[]>([])
  const [statuses, setStatuses] = useState<StatusRow[]>([])
  const [tags, setTags] = useState<TagRow[]>([])
  const [users, setUsers] = useState<UserRow[]>([])
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Macro | null>(null)
  const [form, setForm] = useState<MacroFormState>(emptyMacroForm())

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      // Macros / statuses / tags / templates all honor ?company_id for
      // super_admin; company_admins are scoped to their own company regardless.
      const qs = activeCompanyId
        ? `?company_id=${encodeURIComponent(activeCompanyId)}`
        : ''
      // Users come straight from the table (RLS-scoped), same as Routing Rules.
      let usersQuery = supabase
        .from('users')
        .select('id, email, full_name')
        .eq('is_active', true)
        .order('email')
      if (activeCompanyId) usersQuery = usersQuery.eq('company_id', activeCompanyId)

      const [macrosRes, statusRes, tagsRes, templatesRes, usersRes] =
        await Promise.all([
          fetch(`/api/macros${qs}`, { cache: 'no-store' }),
          fetch(`/api/company-statuses${qs}`, { cache: 'no-store' }),
          fetch(`/api/company-tags${qs}`, { cache: 'no-store' }),
          fetch(`/api/templates${qs}`, { cache: 'no-store' }),
          usersQuery,
        ])

      if (macrosRes.ok) {
        const j = (await macrosRes.json()) as { macros?: Macro[] }
        setMacros((j.macros || []) as Macro[])
      } else {
        const j = await macrosRes.json().catch(() => ({}))
        toast.error(`Failed to load macros: ${j.error || macrosRes.status}`)
      }

      if (statusRes.ok) {
        const j = (await statusRes.json()) as { statuses?: StatusRow[] }
        setStatuses((j.statuses || []) as StatusRow[])
      }
      if (tagsRes.ok) {
        const j = (await tagsRes.json()) as { tags?: TagRow[] }
        setTags((j.tags || []) as TagRow[])
      }
      if (templatesRes.ok) {
        const j = (await templatesRes.json()) as { templates?: TemplateRow[] }
        setTemplates((j.templates || []) as TemplateRow[])
      }
      if (!usersRes.error && usersRes.data) setUsers(usersRes.data as UserRow[])
    } catch (err) {
      toast.error(
        `Failed to load: ${err instanceof Error ? err.message : 'unknown'}`,
      )
    }
    setLoading(false)
  }, [supabase, toast, activeCompanyId])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // Lookup maps so the list summary shows assignee / template names, not uuids.
  const userNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of users) m.set(u.id, u.full_name ? `${u.full_name}` : u.email)
    return m
  }, [users])
  const templateTitleById = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of templates) m.set(t.id, t.title)
    return m
  }, [templates])

  const summaryLabels = useMemo(
    () => ({
      assigneeName: (id: string) => userNameById.get(id),
      templateName: (id: string) => templateTitleById.get(id),
    }),
    [userNameById, templateTitleById],
  )

  // Union of catalog tag names + any names already on the macro that are no
  // longer in the catalog (so editing a macro with a deleted tag still works).
  const tagColorByName = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of tags) m.set(t.name, t.color)
    return m
  }, [tags])
  const tagChoices = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const t of tags) {
      if (!seen.has(t.name)) {
        seen.add(t.name)
        out.push(t.name)
      }
    }
    for (const name of form.add_tags) {
      if (!seen.has(name)) {
        seen.add(name)
        out.push(name)
      }
    }
    return out
  }, [tags, form.add_tags])

  const openAdd = () => {
    setEditing(null)
    setForm(emptyMacroForm())
    setShowModal(true)
  }

  const openEdit = (macro: Macro) => {
    setEditing(macro)
    setForm(actionsToForm(macro.actions, macro.name, macro.description, macro.is_active))
    setShowModal(true)
  }

  const toggleTag = (name: string) => {
    setForm((f) =>
      f.add_tags.includes(name)
        ? { ...f, add_tags: f.add_tags.filter((t) => t !== name) }
        : { ...f, add_tags: [...f.add_tags, name] },
    )
  }

  const handleSave = async () => {
    const name = form.name.trim()
    if (!name) {
      toast.error('Name is required')
      return
    }
    const actions = buildMacroActions(form)
    if (Object.keys(actions).length === 0) {
      toast.error('Add at least one action (status, priority, tags, assignee, or template)')
      return
    }

    setSaving(true)
    const body: Record<string, unknown> = {
      name,
      description: form.description.trim() || null,
      actions,
      is_active: form.is_active,
    }
    // super_admin: create under the active tenant. company_admin path ignores
    // this and uses its own company server-side. PATCH derives scope from the
    // existing row, so company_id is POST-only.
    if (!editing && activeCompanyId) body.company_id = activeCompanyId

    try {
      const res = editing
        ? await fetch(`/api/macros/${editing.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetch('/api/macros', {
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
      toast.success(editing ? 'Macro updated' : 'Macro created')
      setShowModal(false)
      await loadAll()
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : 'unknown'}`)
    }
    setSaving(false)
  }

  const handleDelete = async (macro: Macro) => {
    if (!window.confirm(`Delete macro "${macro.name}"? This can't be undone.`)) return
    const res = await fetch(`/api/macros/${macro.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      toast.error(`Delete failed: ${j.error || res.status}`)
      return
    }
    toast.success('Macro deleted')
    setMacros((prev) => prev.filter((m) => m.id !== macro.id))
  }

  const toggleActive = async (macro: Macro) => {
    const next = !macro.is_active
    // Optimistic flip; revert on failure (mirrors Routing Rules).
    setMacros((prev) =>
      prev.map((m) => (m.id === macro.id ? { ...m, is_active: next } : m)),
    )
    const res = await fetch(`/api/macros/${macro.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: next }),
    })
    if (!res.ok) {
      setMacros((prev) =>
        prev.map((m) => (m.id === macro.id ? { ...m, is_active: !next } : m)),
      )
      toast.error('Failed to toggle macro')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        <span className="ml-3 text-gray-500">Loading macros…</span>
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-fade-in p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Workflow Macros</h1>
          <p className="mt-1 text-sm text-gray-500">
            Reusable bundles of one-click conversation actions. Agents apply them
            from the conversation actions — a macro never sends a message.
          </p>
        </div>
        <Button onClick={openAdd}>
          <Plus className="h-4 w-4" /> Add macro
        </Button>
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-700 ring-1 ring-teal-200">
          <Zap className="h-3.5 w-3.5" />
          {macros.length} total
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
          {macros.filter((m) => m.is_active).length} active
        </span>
      </div>

      {/* Macros table */}
      <div className="rounded-2xl border border-gray-200/80 bg-white p-1 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
        {macros.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-500">
            <Zap className="h-8 w-8 text-gray-300 mb-2" />
            <p className="font-medium text-gray-700">No macros yet</p>
            <p className="text-sm mt-1">
              Create a macro to let agents apply common actions in one click.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Actions</TableHead>
                <TableHead className="text-right">Edit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {macros.map((macro) => (
                <TableRow key={macro.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Zap className="h-4 w-4 text-teal-500" />
                      <div className="min-w-0">
                        <span className="font-medium text-gray-900">{macro.name}</span>
                        {macro.description && (
                          <p className="line-clamp-1 text-xs text-gray-500">
                            {macro.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <button
                      onClick={() => toggleActive(macro)}
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                        macro.is_active
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {macro.is_active ? 'On' : 'Off'}
                    </button>
                  </TableCell>
                  <TableCell className="max-w-md text-xs text-gray-600">
                    <span className="line-clamp-2">
                      {summarizeMacroActions(macro.actions, summaryLabels)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        onClick={() => openEdit(macro)}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                        title="Edit"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(macro)}
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
        title={editing ? 'Edit macro' : 'New macro'}
        className="sm:max-w-2xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={!form.name.trim()}>
              {editing ? 'Update macro' : 'Create macro'}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          {/* Name + active */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
            <div className="sm:col-span-2">
              <Input
                label="Macro name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g., Escalate to billing"
                maxLength={64}
              />
            </div>
            <div className="pb-1">
              <Toggle
                checked={form.is_active}
                onChange={(v) => setForm({ ...form, is_active: v })}
                label="Active"
                description="Disabled macros are hidden from agents"
              />
            </div>
          </div>

          <Input
            label="Description (optional)"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="What this macro is for"
            maxLength={280}
          />

          {/* Actions */}
          <div className="rounded-2xl border border-gray-200/80 bg-gray-50/50 p-4 space-y-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Actions
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                label="Set status"
                value={form.set_status}
                onChange={(e) => setForm({ ...form, set_status: e.target.value })}
                options={[
                  { value: '', label: '— no change —' },
                  ...statuses.map((s) => ({ value: s.name, label: s.name })),
                ]}
              />
              <Select
                label="Set priority"
                value={form.set_priority}
                onChange={(e) => setForm({ ...form, set_priority: e.target.value })}
                options={PRIORITY_OPTIONS}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                label="Assign to"
                value={form.assign_to}
                onChange={(e) => setForm({ ...form, assign_to: e.target.value })}
                options={[
                  { value: '', label: '— no change —' },
                  { value: UNASSIGN_VALUE, label: 'Unassign' },
                  ...users.map((u) => ({
                    value: u.id,
                    label: u.full_name ? `${u.full_name} (${u.email})` : u.email,
                  })),
                ]}
              />
              <Select
                label="Insert reply template"
                value={form.reply_template_id}
                onChange={(e) =>
                  setForm({ ...form, reply_template_id: e.target.value })
                }
                options={[
                  { value: '', label: '— none —' },
                  ...templates.map((t) => ({ value: t.id, label: t.title })),
                ]}
              />
            </div>

            {/* Tags multi-select */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                <Tag className="mr-1 inline h-3.5 w-3.5" />
                Add tags
              </label>
              {tagChoices.length === 0 ? (
                <p className="text-xs text-gray-400">
                  No tags defined yet. Add some under{' '}
                  <span className="font-medium">Statuses &amp; Tags</span>.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {tagChoices.map((name) => {
                    const selected = form.add_tags.includes(name)
                    const color = tagColorByName.get(name) || '#6b7280'
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => toggleTag(name)}
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                          selected
                            ? 'border-teal-300 bg-teal-50 text-teal-700'
                            : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {selected ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-teal-600" />
                        ) : (
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: color }}
                          />
                        )}
                        {name}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <p className="text-[11px] leading-snug text-gray-400">
            Macros update the conversation only — status, tags, assignee, and
            priority. They never send a message; a reply template is only queued
            for the agent to review and send.
          </p>
        </div>
      </Modal>
    </div>
  )
}
