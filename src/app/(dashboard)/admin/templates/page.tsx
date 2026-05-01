'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  Search,
  Plus,
  RefreshCw,
  MessageSquare,
  FolderOpen,
  TrendingUp,
  ToggleLeft,
  Pencil,
  Trash2,
  CheckCircle2,
  FileQuestion,
  Loader2,
  AlertTriangle,
  Hash,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Modal } from '@/components/ui/modal'
import { Toggle } from '@/components/ui/toggle'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import type { ReplyTemplate } from '@/types/database'
import { cn, truncate, timeAgo } from '@/lib/utils'
import { substituteTemplate, TEMPLATE_VARIABLES } from '@/lib/templates'

const CATEGORIES = ['General', 'Sales', 'Technical', 'Billing', 'Support']

const CATEGORY_OPTIONS = [
  { value: '', label: 'All Categories' },
  ...CATEGORIES.map((c) => ({ value: c, label: c })),
]

function getCategoryVariant(category: string): 'info' | 'warning' | 'success' | 'default' {
  switch (category) {
    case 'Technical':
      return 'info'
    case 'Billing':
      return 'warning'
    case 'Sales':
      return 'success'
    case 'Support':
      return 'info'
    case 'General':
      return 'default'
    default:
      return 'default'
  }
}

// Sample values used by the live preview pane in the create/edit modal.
// Substituted via `substituteTemplate` so admins can verify formatting
// before saving.
const PREVIEW_CONTEXT = {
  customer: { name: 'Sample Customer', email: 'customer@example.com' },
  user: { full_name: 'Agent Smith', email: 'agent@yourcompany.com' },
  company: { name: 'Your Company' },
  conversation: { subject: 'Question about your service' },
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<ReplyTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState<ReplyTemplate | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editForm, setEditForm] = useState({
    title: '',
    subject: '',
    content: '',
    category: 'General',
    shortcut: '',
  })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Fetch templates from the API (auto-scoped by RLS on the server)
  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/templates')
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.error || `HTTP ${res.status}`)
        setTemplates([])
        return
      }
      const data = (await res.json()) as { templates?: ReplyTemplate[] }
      setTemplates(data.templates ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load templates')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  // Derived stats
  const totalTemplates = templates.length
  const categoriesCount = new Set(templates.map((t) => t.category).filter(Boolean)).size
  const mostUsed = templates.reduce(
    (best, t) => (t.usage_count > best.usage_count ? t : best),
    { title: 'None', usage_count: 0 } as Pick<ReplyTemplate, 'title' | 'usage_count'>
  )
  const activeCount = templates.filter((t) => t.is_active).length
  const inactiveCount = templates.length - activeCount

  // Filtered templates
  const filteredTemplates = useMemo(() => {
    return templates.filter((template) => {
      const matchesSearch =
        !searchQuery ||
        template.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        template.content.toLowerCase().includes(searchQuery.toLowerCase())
      const matchesCategory = !categoryFilter || template.category === categoryFilter
      return matchesSearch && matchesCategory
    })
  }, [templates, searchQuery, categoryFilter])

  // ── Handlers ──────────────────────────────────────────────────────────

  async function handleToggleActive(id: string) {
    const template = templates.find((t) => t.id === id)
    if (!template) return
    const newValue = !template.is_active

    // Optimistic update
    setTemplates((prev) =>
      prev.map((t) => (t.id === id ? { ...t, is_active: newValue } : t))
    )

    const res = await fetch(`/api/templates/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: newValue }),
    })
    if (!res.ok) {
      // Revert
      setTemplates((prev) =>
        prev.map((t) => (t.id === id ? { ...t, is_active: !newValue } : t))
      )
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Are you sure you want to delete this template? This cannot be undone.')) {
      return
    }
    const previous = templates
    setTemplates((prev) => prev.filter((t) => t.id !== id))
    const res = await fetch(`/api/templates/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      setTemplates(previous)
    }
  }

  function handleOpenTemplate(template: ReplyTemplate) {
    setSelectedTemplate(template)
    setModalOpen(true)
  }

  function handleCloseModal() {
    setModalOpen(false)
    setSelectedTemplate(null)
  }

  function handleOpenAdd() {
    setEditingId(null)
    setSaveError(null)
    setEditForm({ title: '', subject: '', content: '', category: 'General', shortcut: '' })
    setEditModalOpen(true)
  }

  function handleOpenEdit(template: ReplyTemplate) {
    setEditingId(template.id)
    setSaveError(null)
    setEditForm({
      title: template.title,
      subject: template.subject || '',
      content: template.content,
      category: template.category || 'General',
      shortcut: template.shortcut || '',
    })
    setEditModalOpen(true)
    setModalOpen(false)
  }

  async function handleSaveTemplate() {
    if (!editForm.title.trim() || !editForm.content.trim()) return
    setSaving(true)
    setSaveError(null)

    const payload = {
      name: editForm.title.trim(),
      subject: editForm.subject.trim() || null,
      body: editForm.content,
      category: editForm.category,
      shortcut: editForm.shortcut.trim() || null,
    }

    let res: Response
    if (editingId) {
      res = await fetch(`/api/templates/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } else {
      res = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    setSaving(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setSaveError(j.error || `HTTP ${res.status}`)
      return
    }

    setEditModalOpen(false)
    fetchTemplates()
  }

  // Live-preview substitution for the create/edit modal.
  const previewBody = substituteTemplate(editForm.content, PREVIEW_CONTEXT)
  const previewSubject = substituteTemplate(editForm.subject, PREVIEW_CONTEXT)

  if (loading) {
    return (
      <div className="flex h-80 items-center justify-center animate-fade-in">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-xl bg-blue-100 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-gray-700">Loading templates</p>
            <p className="text-xs text-gray-400 mt-1">Fetching reply templates...</p>
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-24 animate-fade-in">
        <div className="h-12 w-12 rounded-xl bg-red-100 flex items-center justify-center mb-4">
          <AlertTriangle className="h-6 w-6 text-red-600" />
        </div>
        <p className="text-red-700 font-medium">Failed to load templates</p>
        <p className="text-sm text-gray-500 mt-1">{error}</p>
        <Button variant="secondary" className="mt-4" onClick={() => fetchTemplates()}>
          <RefreshCw className="h-4 w-4" />
          Try Again
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Reply Templates</h1>
            <p className="mt-1 text-sm text-gray-500">
              Manage pre-written reply templates for quick customer responses
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <Button variant="secondary" size="sm" onClick={() => fetchTemplates()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button size="sm" onClick={handleOpenAdd}>
            <Plus className="h-4 w-4" />
            Add Template
          </Button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
              <MessageSquare className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Total Templates</p>
              <p className="text-2xl font-bold text-gray-900">{totalTemplates}</p>
            </div>
          </div>
        </Card>
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100 text-purple-700">
              <FolderOpen className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Categories</p>
              <p className="text-2xl font-bold text-gray-900">{categoriesCount}</p>
            </div>
          </div>
        </Card>
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100 text-green-700">
              <TrendingUp className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Most Used</p>
              <p className="text-2xl font-bold text-gray-900 truncate max-w-[140px]" title={mostUsed.title}>
                {truncate(mostUsed.title, 18)}
              </p>
            </div>
          </div>
        </Card>
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-100 text-orange-700">
              <ToggleLeft className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Active / Inactive</p>
              <p className="text-2xl font-bold text-gray-900">
                {activeCount} / {inactiveCount}
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Search and filter bar */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <Input
            placeholder="Search templates by title or content..."
            icon={<Search className="h-4 w-4" />}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            options={CATEGORY_OPTIONS}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          />
        </div>
      </div>

      {/* Templates table */}
      <Card>
        {filteredTemplates.length === 0 ? (
          <EmptyState
            icon={FileQuestion}
            title={templates.length === 0 ? 'No templates yet' : 'No templates found'}
            description={
              templates.length === 0
                ? 'Reply templates let your team answer common questions in one click. Create your first template to get started.'
                : 'Try adjusting your search or filter criteria.'
            }
            action={
              templates.length === 0 ? (
                <Button variant="primary" onClick={handleOpenAdd}>
                  <Plus className="h-4 w-4" />
                  Create your first template
                </Button>
              ) : undefined
            }
            hint={
              templates.length === 0
                ? 'Tip: assign a /shortcut to expand templates inline in the reply composer.'
                : undefined
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="hidden lg:table-cell">Preview</TableHead>
                <TableHead className="hidden md:table-cell">Shortcut</TableHead>
                <TableHead className="hidden md:table-cell">Usage</TableHead>
                <TableHead className="hidden lg:table-cell">Updated</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTemplates.map((template) => (
                <TableRow key={template.id}>
                  <TableCell>
                    <button
                      onClick={() => handleOpenTemplate(template)}
                      className={cn(
                        'text-left font-medium text-teal-700 hover:text-teal-900 hover:underline'
                      )}
                    >
                      {template.title}
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant={getCategoryVariant(template.category || 'General')} size="sm">
                      {template.category || 'General'}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden max-w-xs lg:table-cell">
                    <span className="text-sm text-gray-500">
                      {truncate(template.content, 150)}
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {template.shortcut ? (
                      <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs font-mono text-gray-600">
                        <Hash className="h-3 w-3" />
                        {template.shortcut}
                      </span>
                    ) : (
                      <span className="text-sm text-gray-400">--</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap md:table-cell">
                    <span className="text-sm text-gray-700 font-medium">
                      {template.usage_count}
                    </span>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap lg:table-cell">
                    <span className="text-sm text-gray-500">
                      {timeAgo(template.updated_at)} ago
                    </span>
                  </TableCell>
                  <TableCell>
                    <Toggle
                      checked={template.is_active}
                      onChange={() => handleToggleActive(template.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleOpenEdit(template)}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                        title="Edit template"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(template.id)}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                        title="Delete template"
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
      </Card>

      {/* Template detail modal */}
      <Modal
        open={modalOpen}
        onClose={handleCloseModal}
        title={selectedTemplate?.title ?? 'Template Details'}
        className="sm:max-w-2xl"
        footer={
          <>
            <Button variant="secondary" onClick={handleCloseModal}>
              Close
            </Button>
            <Button onClick={() => selectedTemplate && handleOpenEdit(selectedTemplate)}>
              <Pencil className="h-4 w-4" />
              Edit Template
            </Button>
          </>
        }
      >
        {selectedTemplate && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Badge variant={getCategoryVariant(selectedTemplate.category || 'General')}>
                {selectedTemplate.category || 'General'}
              </Badge>
              <Badge variant={selectedTemplate.is_active ? 'success' : 'default'}>
                {selectedTemplate.is_active ? 'Active' : 'Inactive'}
              </Badge>
            </div>

            {selectedTemplate.shortcut && (
              <div>
                <h4 className="mb-1 text-sm font-medium text-gray-500">Shortcut</h4>
                <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-sm font-mono text-gray-700">
                  <Hash className="h-3.5 w-3.5" />
                  {selectedTemplate.shortcut}
                </span>
              </div>
            )}

            {selectedTemplate.subject && (
              <div>
                <h4 className="mb-1 text-sm font-medium text-gray-500">Subject</h4>
                <p className="text-sm text-gray-700">{selectedTemplate.subject}</p>
              </div>
            )}

            <div>
              <h4 className="mb-1 text-sm font-medium text-gray-500">Content</h4>
              <p className="text-sm leading-relaxed text-gray-700 whitespace-pre-wrap">
                {selectedTemplate.content}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-4 rounded-lg bg-gray-50 p-3">
              <div>
                <p className="text-xs text-gray-500">Created</p>
                <p className="text-sm font-medium text-gray-700">
                  {timeAgo(selectedTemplate.created_at)} ago
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Updated</p>
                <p className="text-sm font-medium text-gray-700">
                  {timeAgo(selectedTemplate.updated_at)} ago
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Usage Count</p>
                <p className="text-sm font-medium text-gray-700">
                  {selectedTemplate.usage_count}
                </p>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Create/Edit Template Modal */}
      <Modal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        title={editingId ? 'Edit Template' : 'Add New Template'}
        className="sm:max-w-3xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditModalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveTemplate}
              loading={saving}
              disabled={!editForm.title.trim() || !editForm.content.trim()}
            >
              <CheckCircle2 className="h-4 w-4" />
              {editingId ? 'Save Changes' : 'Create Template'}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Form column */}
          <div className="space-y-4">
            {saveError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {saveError}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
              <input
                type="text"
                value={editForm.title}
                onChange={(e) => setEditForm((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="e.g., Thank you for contacting us"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Subject <span className="text-gray-400 font-normal">(email only)</span>
              </label>
              <input
                type="text"
                value={editForm.subject}
                onChange={(e) => setEditForm((prev) => ({ ...prev, subject: e.target.value }))}
                placeholder="Re: {{conversation.subject}}"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
              <select
                value={editForm.category}
                onChange={(e) => setEditForm((prev) => ({ ...prev, category: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Body *</label>
              <textarea
                value={editForm.content}
                onChange={(e) => setEditForm((prev) => ({ ...prev, content: e.target.value }))}
                placeholder="Hi {{customer.name}},&#10;&#10;Thanks for reaching out..."
                rows={10}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 resize-y min-h-[200px] font-mono"
              />
              <p className="mt-1 text-xs text-gray-400">
                {editForm.content.split(/\s+/).filter(Boolean).length} words. Available variables:{' '}
                {TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(', ')}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Shortcut</label>
              <input
                type="text"
                value={editForm.shortcut}
                onChange={(e) => setEditForm((prev) => ({ ...prev, shortcut: e.target.value }))}
                placeholder="e.g., welcome, rates, hours"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
              <p className="mt-1 text-xs text-gray-400">
                Optional. Agents type <span className="font-mono">/{editForm.shortcut || 'shortcut'}</span> in
                the composer to insert this template.
              </p>
            </div>
          </div>

          {/* Live preview column */}
          <div className="space-y-3">
            <div>
              <h4 className="text-sm font-medium text-gray-700">Preview</h4>
              <p className="text-xs text-gray-400">
                Sample values: customer.name = &quot;Sample Customer&quot;, user.full_name = &quot;Agent Smith&quot;.
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 min-h-[280px]">
              {editForm.subject && (
                <div className="mb-3">
                  <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Subject</p>
                  <p className="text-sm font-medium text-gray-900">{previewSubject}</p>
                </div>
              )}
              <div>
                {editForm.subject && (
                  <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Body</p>
                )}
                <p className="text-sm text-gray-700 whitespace-pre-wrap">
                  {previewBody || (
                    <span className="text-gray-400 italic">
                      Type a template body to see the preview.
                    </span>
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
