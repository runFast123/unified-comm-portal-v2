'use client'

/**
 * Admin → Statuses & Tags
 *
 * Per-company catalog editor for:
 *   * conversation secondary statuses (with color + sort order)
 *   * conversation tags             (with color)
 *
 * Server-side route guard already lives in `../layout.tsx`. The /api/* routes
 * also re-check role via `isCompanyAdmin`, so even without this page a non-admin
 * couldn't mutate the catalog.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Pencil,
  Plus,
  Tags as TagsIcon,
  Trash2,
} from 'lucide-react'

interface CompanyStatus {
  id: string
  name: string
  color: string
  description: string | null
  sort_order: number
  is_active: boolean
}

interface CompanyTag {
  id: string
  name: string
  color: string
  description: string | null
}

const DEFAULT_COLOR = '#6b7280'

export default function TaxonomyPage() {
  const { toast } = useToast()

  // ── Data ──────────────────────────────────────────────────────────
  const [statuses, setStatuses] = useState<CompanyStatus[]>([])
  const [tags, setTags] = useState<CompanyTag[]>([])
  const [loading, setLoading] = useState(true)

  // ── Modal state ───────────────────────────────────────────────────
  const [statusModalOpen, setStatusModalOpen] = useState(false)
  const [editingStatus, setEditingStatus] = useState<CompanyStatus | null>(null)
  const [statusForm, setStatusForm] = useState({ name: '', color: DEFAULT_COLOR, description: '' })
  const [savingStatus, setSavingStatus] = useState(false)

  const [tagModalOpen, setTagModalOpen] = useState(false)
  const [editingTag, setEditingTag] = useState<CompanyTag | null>(null)
  const [tagForm, setTagForm] = useState({ name: '', color: DEFAULT_COLOR, description: '' })
  const [savingTag, setSavingTag] = useState(false)

  const [busyId, setBusyId] = useState<string | null>(null)

  const reloadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [sRes, tRes] = await Promise.all([
        fetch('/api/company-statuses'),
        fetch('/api/company-tags'),
      ])
      const sJson = (await sRes.json()) as { statuses?: CompanyStatus[]; error?: string }
      const tJson = (await tRes.json()) as { tags?: CompanyTag[]; error?: string }
      if (!sRes.ok) throw new Error(sJson.error || 'Failed to load statuses')
      if (!tRes.ok) throw new Error(tJson.error || 'Failed to load tags')
      setStatuses(sJson.statuses ?? [])
      setTags(tJson.tags ?? [])
    } catch (err: any) {
      toast.error(err.message || 'Failed to load taxonomy')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void reloadAll()
  }, [reloadAll])

  // ── Sorted views ──────────────────────────────────────────────────
  const sortedStatuses = useMemo(
    () => [...statuses].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [statuses],
  )
  const sortedTags = useMemo(
    () => [...tags].sort((a, b) => a.name.localeCompare(b.name)),
    [tags],
  )

  // ── Status handlers ───────────────────────────────────────────────
  const openCreateStatus = () => {
    setEditingStatus(null)
    setStatusForm({ name: '', color: DEFAULT_COLOR, description: '' })
    setStatusModalOpen(true)
  }
  const openEditStatus = (s: CompanyStatus) => {
    setEditingStatus(s)
    setStatusForm({ name: s.name, color: s.color, description: s.description ?? '' })
    setStatusModalOpen(true)
  }
  const submitStatus = async () => {
    if (!statusForm.name.trim()) {
      toast.error('Name is required')
      return
    }
    setSavingStatus(true)
    try {
      const url = editingStatus
        ? `/api/company-statuses/${editingStatus.id}`
        : '/api/company-statuses'
      const method = editingStatus ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: statusForm.name.trim(),
          color: statusForm.color,
          description: statusForm.description.trim() || null,
        }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success(editingStatus ? 'Status updated' : 'Status created')
      setStatusModalOpen(false)
      await reloadAll()
    } catch (err: any) {
      toast.error(err.message || 'Save failed')
    } finally {
      setSavingStatus(false)
    }
  }
  const deleteStatus = async (s: CompanyStatus) => {
    if (!confirm(`Remove status "${s.name}"? Existing conversations keep their label.`)) return
    setBusyId(s.id)
    try {
      const res = await fetch(`/api/company-statuses/${s.id}`, { method: 'DELETE' })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Delete failed')
      toast.success('Status removed')
      await reloadAll()
    } catch (err: any) {
      toast.error(err.message || 'Delete failed')
    } finally {
      setBusyId(null)
    }
  }
  const moveStatus = async (s: CompanyStatus, direction: 'up' | 'down') => {
    const idx = sortedStatuses.findIndex((x) => x.id === s.id)
    const swapWith = sortedStatuses[idx + (direction === 'up' ? -1 : 1)]
    if (!swapWith) return
    setBusyId(s.id)
    try {
      // Swap sort_order in two PATCHes; UI reorders on reload.
      const r1 = await fetch(`/api/company-statuses/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sort_order: swapWith.sort_order }),
      })
      const r2 = await fetch(`/api/company-statuses/${swapWith.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sort_order: s.sort_order }),
      })
      if (!r1.ok || !r2.ok) throw new Error('Reorder failed')
      await reloadAll()
    } catch (err: any) {
      toast.error(err.message || 'Reorder failed')
    } finally {
      setBusyId(null)
    }
  }

  // ── Tag handlers ──────────────────────────────────────────────────
  const openCreateTag = () => {
    setEditingTag(null)
    setTagForm({ name: '', color: DEFAULT_COLOR, description: '' })
    setTagModalOpen(true)
  }
  const openEditTag = (t: CompanyTag) => {
    setEditingTag(t)
    setTagForm({ name: t.name, color: t.color, description: t.description ?? '' })
    setTagModalOpen(true)
  }
  const submitTag = async () => {
    if (!tagForm.name.trim()) {
      toast.error('Name is required')
      return
    }
    setSavingTag(true)
    try {
      const url = editingTag ? `/api/company-tags/${editingTag.id}` : '/api/company-tags'
      const method = editingTag ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: tagForm.name.trim(),
          color: tagForm.color,
          description: tagForm.description.trim() || null,
        }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success(editingTag ? 'Tag updated' : 'Tag created')
      setTagModalOpen(false)
      await reloadAll()
    } catch (err: any) {
      toast.error(err.message || 'Save failed')
    } finally {
      setSavingTag(false)
    }
  }
  const deleteTag = async (t: CompanyTag) => {
    if (!confirm(`Remove tag "${t.name}"? Existing conversations keep the tag string.`)) return
    setBusyId(t.id)
    try {
      const res = await fetch(`/api/company-tags/${t.id}`, { method: 'DELETE' })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Delete failed')
      toast.success('Tag removed')
      await reloadAll()
    } catch (err: any) {
      toast.error(err.message || 'Delete failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center gap-3">
        <TagsIcon className="h-6 w-6 text-teal-700" />
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Statuses & Tags</h1>
          <p className="text-sm text-gray-500">
            Custom labels for your team. Built-in lifecycle statuses (Active, In Progress, Resolved
            …) stay the same — these are extra sub-statuses and tags you can attach to a conversation.
          </p>
        </div>
      </header>

      {/* ── Statuses ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <div>
            <h2 className="font-semibold text-gray-900">Custom statuses</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Shown as a secondary status pill on conversations. Use up/down arrows to reorder.
            </p>
          </div>
          <Button onClick={openCreateStatus} size="sm">
            <Plus className="h-4 w-4 mr-1" /> Add status
          </Button>
        </div>
        {loading ? (
          <div className="p-8 flex items-center justify-center text-gray-400 text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
          </div>
        ) : sortedStatuses.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">
            No custom statuses yet. Click <span className="font-medium">Add status</span> to create
            your first one.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">Order</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Color</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedStatuses.map((s, idx) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <button
                        type="button"
                        disabled={idx === 0 || busyId === s.id}
                        onClick={() => moveStatus(s, 'up')}
                        className="text-gray-400 hover:text-teal-700 disabled:opacity-30"
                        aria-label="Move up"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === sortedStatuses.length - 1 || busyId === s.id}
                        onClick={() => moveStatus(s, 'down')}
                        className="text-gray-400 hover:text-teal-700 disabled:opacity-30"
                        aria-label="Move down"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full border border-black/5"
                        style={{ background: s.color }}
                      />
                      <span className="font-medium text-gray-900">{s.name}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs text-gray-500">{s.color}</code>
                  </TableCell>
                  <TableCell className="text-sm text-gray-500 max-w-md truncate">
                    {s.description || <span className="text-gray-300">—</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditStatus(s)}
                        disabled={busyId === s.id}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteStatus(s)}
                        disabled={busyId === s.id}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* ── Tags ─────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <div>
            <h2 className="font-semibold text-gray-900">Tags</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Used by the conversation tag picker for autocomplete and chip colors.
            </p>
          </div>
          <Button onClick={openCreateTag} size="sm">
            <Plus className="h-4 w-4 mr-1" /> Add tag
          </Button>
        </div>
        {loading ? (
          <div className="p-8 flex items-center justify-center text-gray-400 text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
          </div>
        ) : sortedTags.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">
            No tags yet. Click <span className="font-medium">Add tag</span> to create your first one.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Color</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedTags.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border"
                      style={{
                        background: hexToBg(t.color),
                        color: hexToFg(t.color),
                        borderColor: t.color,
                      }}
                    >
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: t.color }}
                      />
                      {t.name}
                    </span>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs text-gray-500">{t.color}</code>
                  </TableCell>
                  <TableCell className="text-sm text-gray-500 max-w-md truncate">
                    {t.description || <span className="text-gray-300">—</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditTag(t)}
                        disabled={busyId === t.id}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteTag(t)}
                        disabled={busyId === t.id}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* ── Status modal ─────────────────────────────────────────── */}
      <Modal
        open={statusModalOpen}
        onClose={() => setStatusModalOpen(false)}
        title={editingStatus ? 'Edit status' : 'New status'}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setStatusModalOpen(false)} disabled={savingStatus}>
              Cancel
            </Button>
            <Button onClick={submitStatus} disabled={savingStatus}>
              {savingStatus && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Save
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <label className="block text-sm font-medium text-gray-700">
            Name
            <Input
              value={statusForm.name}
              onChange={(e) =>
                setStatusForm((f) => ({ ...f, name: (e.target as HTMLInputElement).value }))
              }
              placeholder="awaiting_legal_review"
              maxLength={64}
              autoFocus
            />
          </label>
          <label className="block text-sm font-medium text-gray-700">
            Color
            <div className="mt-1 flex items-center gap-2">
              <input
                type="color"
                value={statusForm.color}
                onChange={(e) => setStatusForm((f) => ({ ...f, color: e.target.value }))}
                className="h-9 w-16 rounded border border-gray-200 cursor-pointer"
                aria-label="Status color"
              />
              <Input
                value={statusForm.color}
                onChange={(e) =>
                  setStatusForm((f) => ({ ...f, color: (e.target as HTMLInputElement).value }))
                }
                className="flex-1"
                maxLength={32}
              />
            </div>
          </label>
          <label className="block text-sm font-medium text-gray-700">
            Description (optional)
            <Input
              value={statusForm.description}
              onChange={(e) =>
                setStatusForm((f) => ({
                  ...f,
                  description: (e.target as HTMLInputElement).value,
                }))
              }
              placeholder="Internal note for team"
              maxLength={280}
            />
          </label>
        </div>
      </Modal>

      {/* ── Tag modal ───────────────────────────────────────────── */}
      <Modal
        open={tagModalOpen}
        onClose={() => setTagModalOpen(false)}
        title={editingTag ? 'Edit tag' : 'New tag'}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setTagModalOpen(false)} disabled={savingTag}>
              Cancel
            </Button>
            <Button onClick={submitTag} disabled={savingTag}>
              {savingTag && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Save
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <label className="block text-sm font-medium text-gray-700">
            Name
            <Input
              value={tagForm.name}
              onChange={(e) =>
                setTagForm((f) => ({ ...f, name: (e.target as HTMLInputElement).value }))
              }
              placeholder="vip"
              maxLength={48}
              autoFocus
            />
          </label>
          <label className="block text-sm font-medium text-gray-700">
            Color
            <div className="mt-1 flex items-center gap-2">
              <input
                type="color"
                value={tagForm.color}
                onChange={(e) => setTagForm((f) => ({ ...f, color: e.target.value }))}
                className="h-9 w-16 rounded border border-gray-200 cursor-pointer"
                aria-label="Tag color"
              />
              <Input
                value={tagForm.color}
                onChange={(e) =>
                  setTagForm((f) => ({ ...f, color: (e.target as HTMLInputElement).value }))
                }
                className="flex-1"
                maxLength={32}
              />
            </div>
          </label>
          <label className="block text-sm font-medium text-gray-700">
            Description (optional)
            <Input
              value={tagForm.description}
              onChange={(e) =>
                setTagForm((f) => ({
                  ...f,
                  description: (e.target as HTMLInputElement).value,
                }))
              }
              placeholder="Internal note for team"
              maxLength={280}
            />
          </label>
        </div>
      </Modal>
    </div>
  )
}

// Helpers — convert a hex color into a soft chip background and a foreground
// that stays legible on it. We don't bother with fancy color theory: the chip
// background is a 18%-opacity wash and the text is the user's chosen color.
function hexToBg(color: string): string {
  if (!color) return 'rgba(107, 114, 128, 0.12)'
  if (color.startsWith('#')) {
    const c = color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color
    const r = parseInt(c.slice(1, 3), 16)
    const g = parseInt(c.slice(3, 5), 16)
    const b = parseInt(c.slice(5, 7), 16)
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return `rgba(${r}, ${g}, ${b}, 0.12)`
    }
  }
  return 'rgba(107, 114, 128, 0.12)'
}
function hexToFg(color: string): string {
  return color || '#374151'
}
