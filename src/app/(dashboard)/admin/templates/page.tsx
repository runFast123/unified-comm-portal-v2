'use client'

import { useState, useMemo, useEffect } from 'react'
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
import { createClient } from '@/lib/supabase-client'
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

const supabase = createClient()

interface AccountOption {
  id: string
  name: string
}

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

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<ReplyTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [accountFilter, setAccountFilter] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState<ReplyTemplate | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editForm, setEditForm] = useState({
    title: '',
    content: '',
    category: 'General',
    shortcut: '',
    account_id: '',
  })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [accounts, setAccounts] = useState<AccountOption[]>([])

  // Fetch accounts for filter/selector
  async function fetchAccounts() {
    const { data } = await supabase
      .from('accounts')
      .select('id, name')
      .eq('is_active', true)
      .order('name')
    if (data) setAccounts(data)
  }

  // Fetch templates from Supabase
  async function fetchTemplates() {
    setLoading(true)
    setError(null)
    const { data, error: fetchError } = await supabase
      .from('reply_templates')
      .select('*')
      .order('updated_at', { ascending: false })

    if (fetchError) {
      setError(fetchError.message)
      setLoading(false)
      return
    }

    setTemplates((data as ReplyTemplate[]) ?? [])
    setLoading(false)
  }

  useEffect(() => {
    fetchTemplates()
    fetchAccounts()
  }, [])

  // Derived stats
  const totalTemplates = templates.length
  const categoriesCount = new Set(templates.map((t) => t.category).filter(Boolean)).size
  const mostUsed = templates.reduce(
    (best, t) => (t.usage_count > best.usage_count ? t : best),
    { title: 'None', usage_count: 0 } as Pick<ReplyTemplate, 'title' | 'usage_count'>
  )
  const activeCount = templates.filter((t) => t.is_active).length
  const inactiveCount = templates.length - activeCount

  // Helper to get account name from id
  function getAccountName(accountId: string | null): string {
    if (!accountId) return 'General'
    const acc = accounts.find((a) => a.id === accountId)
    return acc ? acc.name : 'Unknown'
  }

  // Filtered templates
  const filteredTemplates = useMemo(() => {
    return templates.filter((template) => {
      const matchesSearch =
        !searchQuery ||
        template.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        template.content.toLowerCase().includes(searchQuery.toLowerCase())
      const matchesCategory = !categoryFilter || template.category === categoryFilter
      const matchesAccount =
        !accountFilter ||
        (accountFilter === 'general'
          ? !template.account_id
          : template.account_id === accountFilter)
      return matchesSearch && matchesCategory && matchesAccount
    })
  }, [templates, searchQuery, categoryFilter, accountFilter])

  // Handlers
  async function handleToggleActive(id: string) {
    const template = templates.find((t) => t.id === id)
    if (!template) return

    const newValue = !template.is_active

    // Optimistic update
    setTemplates((prev) =>
      prev.map((t) => (t.id === id ? { ...t, is_active: newValue } : t))
    )

    const { error: updateError } = await supabase
      .from('reply_templates')
      .update({ is_active: newValue })
      .eq('id', id)

    if (updateError) {
      console.error('Failed to toggle template active:', updateError.message)
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
    // Optimistic update
    const previousTemplates = templates
    setTemplates((prev) => prev.filter((t) => t.id !== id))

    const { error: deleteError } = await supabase
      .from('reply_templates')
      .delete()
      .eq('id', id)

    if (deleteError) {
      console.error('Failed to delete template:', deleteError.message)
      // Revert
      setTemplates(previousTemplates)
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
    setEditForm({ title: '', content: '', category: 'General', shortcut: '', account_id: '' })
    setEditModalOpen(true)
  }

  function handleOpenEdit(template: ReplyTemplate) {
    setEditingId(template.id)
    setEditForm({
      title: template.title,
      content: template.content,
      category: template.category || 'General',
      shortcut: template.shortcut || '',
      account_id: template.account_id || '',
    })
    setEditModalOpen(true)
    setModalOpen(false)
  }

  async function handleSaveTemplate() {
    if (!editForm.title.trim() || !editForm.content.trim()) return
    setSaving(true)

    const accountId = editForm.account_id || null

    if (editingId) {
      // Update existing template
      const { error: updateError } = await supabase
        .from('reply_templates')
        .update({
          title: editForm.title.trim(),
          content: editForm.content.trim(),
          category: editForm.category,
          shortcut: editForm.shortcut.trim() || null,
          account_id: accountId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', editingId)

      if (updateError) {
        console.error('Failed to update template:', updateError.message)
      }
    } else {
      // Create new template
      const { error: insertError } = await supabase
        .from('reply_templates')
        .insert({
          title: editForm.title.trim(),
          content: editForm.content.trim(),
          category: editForm.category,
          shortcut: editForm.shortcut.trim() || null,
          account_id: accountId,
          is_active: true,
        })

      if (insertError) {
        console.error('Failed to create template:', insertError.message)
      }
    }

    setSaving(false)
    setEditModalOpen(false)
    fetchTemplates()
  }

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
      {/* ----------------------------------------------------------------- */}
      {/* Page header                                                       */}
      {/* ----------------------------------------------------------------- */}
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

      {/* ----------------------------------------------------------------- */}
      {/* Stats row                                                         */}
      {/* ----------------------------------------------------------------- */}
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

      {/* ----------------------------------------------------------------- */}
      {/* Search and filter bar                                             */}
      {/* ----------------------------------------------------------------- */}
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
          <select
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
          >
            <option value="">All Companies</option>
            <option value="general">General (Shared)</option>
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.name}
              </option>
            ))}
          </select>
        </div>
        <div className="w-full sm:w-48">
          <Select
            options={CATEGORY_OPTIONS}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          />
        </div>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Templates table                                                   */}
      {/* ----------------------------------------------------------------- */}
      <Card>
        {filteredTemplates.length === 0 ? (
          <EmptyState
            icon={<FileQuestion className="h-12 w-12" />}
            title="No templates found"
            description={
              templates.length === 0
                ? 'No reply templates have been created yet. Add your first template to get started.'
                : 'Try adjusting your search or filter criteria.'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="hidden lg:table-cell">Preview</TableHead>
                <TableHead className="hidden md:table-cell">Shortcut</TableHead>
                <TableHead className="hidden md:table-cell">Usage</TableHead>
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
                      className="text-left font-medium text-teal-700 hover:text-teal-900 hover:underline"
                    >
                      {template.title}
                    </button>
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                        template.account_id
                          ? 'bg-teal-50 text-teal-700'
                          : 'bg-gray-100 text-gray-600'
                      )}
                    >
                      {getAccountName(template.account_id)}
                    </span>
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

      {/* ----------------------------------------------------------------- */}
      {/* Template detail modal                                             */}
      {/* ----------------------------------------------------------------- */}
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
              <Badge variant="default" size="sm">
                {getAccountName(selectedTemplate.account_id)}
              </Badge>
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

      {/* ----------------------------------------------------------------- */}
      {/* Create/Edit Template Modal                                        */}
      {/* ----------------------------------------------------------------- */}
      <Modal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        title={editingId ? 'Edit Template' : 'Add New Template'}
        className="sm:max-w-2xl"
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
        <div className="space-y-4">
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Company</label>
            <select
              value={editForm.account_id}
              onChange={(e) => setEditForm((prev) => ({ ...prev, account_id: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="">General (Shared across all companies)</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-400">
              Select which company this template belongs to. &quot;General&quot; templates are shared
              across all companies.
            </p>
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Content *</label>
            <textarea
              value={editForm.content}
              onChange={(e) => setEditForm((prev) => ({ ...prev, content: e.target.value }))}
              placeholder="Write the reply template content..."
              rows={8}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 resize-y min-h-[160px]"
            />
            <p className="mt-1 text-xs text-gray-400">
              {editForm.content.split(/\s+/).filter(Boolean).length} words
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Shortcut</label>
            <input
              type="text"
              value={editForm.shortcut}
              onChange={(e) => setEditForm((prev) => ({ ...prev, shortcut: e.target.value }))}
              placeholder="e.g., /thanks, /rates, /hours"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
            <p className="mt-1 text-xs text-gray-400">
              Optional shortcut for quick access (e.g., /thanks). Agents can type the shortcut to
              insert this template.
            </p>
          </div>
        </div>
      </Modal>
    </div>
  )
}
