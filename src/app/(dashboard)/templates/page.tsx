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
import { Skeleton } from '@/components/ui/skeleton'
import type { ReplyTemplate } from '@/types/database'
import { truncate, timeAgo } from '@/lib/utils'
import { useUser } from '@/context/user-context'
import { useToast } from '@/components/ui/toast'

interface AccountOption {
  id: string
  name: string
  company_id: string | null
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
  const supabase = createClient()
  const { isAdmin, role, companyAccountIds, activeCompanyId } = useUser()
  const isSuper = role === 'super_admin'
  const { toast } = useToast()
  const [templates, setTemplates] = useState<ReplyTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [companyFilter, setCompanyFilter] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState<ReplyTemplate | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editForm, setEditForm] = useState({
    title: '',
    content: '',
    category: 'General',
    shortcut: '',
    account_id: '',
    company_id: '',
  })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([])

  // Fetch accounts for filter/selector
  async function fetchAccounts() {
    let query = supabase
      .from('accounts')
      .select('id, name, company_id')
      .eq('is_active', true)
      .order('name')
    // Scope to the active tenant's accounts. `activeCompanyId === null`
    // (super_admin combined view) leaves the query unscoped so the modal can
    // offer accounts for whichever company a super_admin picks.
    if (activeCompanyId) {
      query = query.in('id', companyAccountIds)
    }
    const { data } = await query
    if (data) setAccounts(data)
  }

  // Companies for the template's owning-tenant picker. RLS returns every
  // company to a super_admin and only their own to a company_admin.
  async function fetchCompanies() {
    const { data } = await supabase.from('companies').select('id, name').order('name')
    if (data) setCompanies(data)
  }

  // Fetch templates from Supabase
  async function fetchTemplates() {
    setLoading(true)
    setError(null)
    let query = supabase
      .from('reply_templates')
      .select('*')
      .order('updated_at', { ascending: false })

    // Company-scoped. A selected tenant filters by company_id; super_admin
    // combined view (activeCompanyId === null) runs unscoped. RLS still limits a
    // company_admin to their own company regardless of this client filter.
    if (activeCompanyId) {
      query = query.eq('company_id', activeCompanyId)
    }

    const { data, error: fetchError } = await query

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
    fetchCompanies()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, companyAccountIds, activeCompanyId])

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
    if (!accountId) return 'All accounts'
    const acc = accounts.find((a) => a.id === accountId)
    return acc ? acc.name : 'Unknown'
  }

  function getCompanyName(companyId: string | null): string {
    if (!companyId) return 'Unknown'
    const c = companies.find((c) => c.id === companyId)
    return c ? c.name : 'Unknown'
  }

  // Filtered templates
  const filteredTemplates = useMemo(() => {
    return templates.filter((template) => {
      const matchesSearch =
        !searchQuery ||
        template.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        template.content.toLowerCase().includes(searchQuery.toLowerCase())
      const matchesCategory = !categoryFilter || template.category === categoryFilter
      const matchesCompany = !companyFilter || template.company_id === companyFilter
      return matchesSearch && matchesCategory && matchesCompany
    })
  }, [templates, searchQuery, categoryFilter, companyFilter])

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
    // Default the owning company to the active tenant (super_admin) or the
    // caller's own company (company_admin → the single company they can read).
    // Scope defaults to "whole company" (account_id = '').
    const defaultCompany = activeCompanyId ?? (companies[0]?.id ?? '')
    setEditForm({
      title: '',
      content: '',
      category: 'General',
      shortcut: '',
      account_id: '',
      company_id: defaultCompany,
    })
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
      company_id: template.company_id || '',
    })
    setEditModalOpen(true)
    setModalOpen(false)
  }

  async function handleSaveTemplate() {
    if (!editForm.title.trim() || !editForm.content.trim()) return
    setSaving(true)

    const accountId = editForm.account_id || null
    // company_id is the tenant key and is REQUIRED — the company-scoped RLS
    // rejects an insert/update whose company_id isn't the caller's company (and
    // a missing company_id used to fail silently for company_admins and create
    // orphaned, invisible templates for super_admins). Super_admins choose it;
    // a company_admin's `companies` list is just their own company.
    const companyId = editForm.company_id || companies[0]?.id || null
    if (!companyId) {
      toast.error('Please select a company for this template.')
      setSaving(false)
      return
    }

    if (editingId) {
      // Update existing template
      const { error: updateError } = await supabase
        .from('reply_templates')
        .update({
          title: editForm.title.trim(),
          content: editForm.content.trim(),
          category: editForm.category,
          shortcut: editForm.shortcut.trim() || null,
          company_id: companyId,
          account_id: accountId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', editingId)

      if (updateError) {
        console.error('Failed to update template:', updateError.message)
        toast.error(updateError.message)
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
          company_id: companyId,
          account_id: accountId,
          is_active: true,
        })

      if (insertError) {
        console.error('Failed to create template:', insertError.message)
        toast.error(insertError.message)
      }
    }

    setSaving(false)
    setEditModalOpen(false)
    fetchTemplates()
  }

  if (loading) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 w-24 rounded-lg" />
            <Skeleton className="h-9 w-28 rounded-lg" />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
            >
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-24 rounded" />
                  <Skeleton className="h-6 w-12 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <Skeleton className="h-11 w-full" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-t border-gray-100 px-4 py-3">
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-40 rounded" />
                <Skeleton className="h-3 w-64 rounded" />
              </div>
              <Skeleton className="h-4 w-20 rounded-full" />
              <Skeleton className="h-8 w-20 rounded-lg" />
            </div>
          ))}
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
        {isSuper && companies.length > 1 && (
          <div className="w-full sm:w-48">
            <select
              value={companyFilter}
              onChange={(e) => setCompanyFilter(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="">All Companies</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
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
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Templates table                                                   */}
      {/* ----------------------------------------------------------------- */}
      <Card>
        {filteredTemplates.length === 0 ? (
          <EmptyState
            icon={FileQuestion}
            title={templates.length === 0 ? 'No templates yet' : 'No templates found'}
            description={
              templates.length === 0
                ? 'Reply templates let you answer common questions with one click. Create your first template to get started.'
                : 'Try adjusting your search or filter criteria.'
            }
            action={
              templates.length === 0 ? (
                <Button variant="primary" onClick={handleOpenAdd}>
                  <Plus className="h-4 w-4" />
                  Create template
                </Button>
              ) : undefined
            }
            hint={templates.length === 0 ? 'Tip: assign a shortcut to paste a template into the reply composer instantly.' : undefined}
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
                    <div className="flex flex-col gap-0.5">
                      <span className="inline-flex w-fit items-center rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700">
                        {getCompanyName(template.company_id)}
                      </span>
                      <span className="text-[11px] text-gray-400">
                        {template.account_id ? getAccountName(template.account_id) : 'All accounts'}
                      </span>
                    </div>
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
                {getCompanyName(selectedTemplate.company_id)}
              </Badge>
              <Badge variant="default" size="sm">
                {selectedTemplate.account_id ? getAccountName(selectedTemplate.account_id) : 'All accounts'}
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
              disabled={!editForm.title.trim() || !editForm.content.trim() || (isAdmin && !editForm.company_id)}
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
          {isAdmin && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Company *</label>
                <select
                  value={editForm.company_id}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, company_id: e.target.value, account_id: '' }))}
                  disabled={!isSuper}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:bg-gray-50 disabled:text-gray-500"
                >
                  {isSuper && <option value="">Select a company…</option>}
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-400">
                  The tenant that owns this template. {isSuper ? 'Pick any company.' : 'Locked to your company.'}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Scope</label>
                <select
                  value={editForm.account_id}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, account_id: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                >
                  <option value="">Whole company (all accounts)</option>
                  {accounts
                    .filter((a) => !editForm.company_id || a.company_id === editForm.company_id)
                    .map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name}
                      </option>
                    ))}
                </select>
                <p className="mt-1 text-xs text-gray-400">
                  Use it company-wide, or limit it to one account.
                </p>
              </div>
            </div>
          )}
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
