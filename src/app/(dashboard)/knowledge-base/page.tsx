'use client'

import { useState, useMemo, useEffect } from 'react'
import {
  Search,
  Plus,
  RefreshCw,
  BookOpen,
  FolderOpen,
  Clock,
  AlertTriangle,
  ExternalLink,
  Pencil,
  Trash2,
  CheckCircle2,
  FileQuestion,
  Loader2,
  Inbox,
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
import { Pagination } from '@/components/ui/pagination'
import { EmptyState } from '@/components/ui/empty-state'
import type { KBArticle } from '@/types/database'
import { cn, truncate, timeAgo } from '@/lib/utils'
import { useUser } from '@/context/user-context'
import Link from 'next/link'
import { useToast } from '@/components/ui/toast'

function GapCount() {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    async function fetch() {
      const supabase = createClient()
      const { count: c } = await supabase
        .from('message_classifications')
        .select('message_id', { count: 'exact', head: true })
        .lt('confidence', 0.6)
      setCount(c || 0)
    }
    fetch()
  }, [])
  return <p className="text-2xl font-bold text-gray-900">{count ?? '...'}</p>
}

// ─── Gap Analysis Component ──────────────────────────────────────────────────

function GapAnalysis() {
  const [gaps, setGaps] = useState<{
    id: string
    message_text: string
    category: string | null
    confidence: number
    sender_name: string | null
    account_name: string | null
    conversation_id: string | null
    timestamp: string
  }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchGaps() {
      setLoading(true)
      const supabase = createClient()

      // Find messages with LOW AI classification confidence (< 0.6) — these are KB gaps
      const { data } = await supabase
        .from('message_classifications')
        .select(`
          message_id,
          category,
          confidence,
          classified_at,
          messages!inner (
            id,
            message_text,
            sender_name,
            conversation_id,
            timestamp,
            is_spam,
            accounts!messages_account_id_fkey ( name )
          )
        `)
        .lt('confidence', 0.6)
        .order('classified_at', { ascending: false })
        .limit(20)

      const mapped = (data || [])
        .filter((d: any) => !d.messages?.is_spam)
        .map((d: any) => ({
          id: d.message_id,
          message_text: d.messages?.message_text || '',
          category: d.category,
          confidence: d.confidence,
          sender_name: d.messages?.sender_name || null,
          account_name: d.messages?.accounts?.name?.replace(/\s+Teams$/i, '') || null,
          conversation_id: d.messages?.conversation_id || null,
          timestamp: d.messages?.timestamp || d.classified_at,
        }))

      setGaps(mapped)
      setLoading(false)
    }
    fetchGaps()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    )
  }

  if (gaps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-gray-400">
        <CheckCircle2 className="h-10 w-10 mb-2 text-green-400" />
        <p className="text-sm font-medium text-gray-500">No knowledge gaps detected</p>
        <p className="text-xs text-gray-400 mt-1">
          All AI classifications have high confidence. Your KB coverage is solid.
        </p>
      </div>
    )
  }

  return (
    <div className="divide-y divide-gray-100 max-h-[400px] overflow-y-auto">
      {gaps.map((gap) => (
        <Link
          key={gap.id}
          href={gap.conversation_id ? `/conversations/${gap.conversation_id}` : '#'}
          className="flex items-start gap-3 py-3 px-1 hover:bg-gray-50 rounded-lg transition-colors group"
        >
          {/* Confidence indicator */}
          <div className={cn(
            'flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold shrink-0 mt-0.5',
            gap.confidence < 0.3 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
          )}>
            {Math.round(gap.confidence * 100)}%
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-sm text-gray-800 line-clamp-2 group-hover:text-teal-700 transition-colors">
              {gap.message_text.substring(0, 150)}{gap.message_text.length > 150 ? '...' : ''}
            </p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {gap.category && (
                <Badge variant="default" size="sm">{gap.category}</Badge>
              )}
              {gap.account_name && (
                <span className="text-xs text-gray-400">{gap.account_name}</span>
              )}
              <span className="text-xs text-gray-400">{timeAgo(gap.timestamp)}</span>
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const title = `${gap.account_name || 'General'} - ${gap.category || 'FAQ'} Gap`
                  const content = `## Topic\n${gap.message_text.substring(0, 200)}\n\n## Answer\n[Draft your answer here based on the customer question above]\n\n## Related Information\n- Category: ${gap.category || 'General'}\n- Confidence was low (${Math.round(gap.confidence * 100)}%) — this topic needs KB coverage`
                  navigator.clipboard.writeText(`Title: ${title}\n\n${content}`)
                  alert('KB article draft copied to clipboard! Paste it in the "Add Article" form.')
                }}
                className="inline-flex items-center gap-1 rounded-md bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-700 hover:bg-teal-100 transition-colors"
              >
                Draft Article
              </button>
            </div>
          </div>

          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-1" />
        </Link>
      ))}
    </div>
  )
}

interface AccountOption {
  id: string
  name: string
}

const CATEGORIES = ['General', 'Billing', 'Technical', 'Sales', 'Support', 'Company Info', 'Products & Services', 'General FAQ']

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

export default function KnowledgeBasePage() {
  const supabase = createClient()
  const { isAdmin, companyAccountIds } = useUser()
  const [articles, setArticles] = useState<KBArticle[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const KB_PAGE_SIZE = 20
  const [kbPage, setKbPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [selectedArticle, setSelectedArticle] = useState<KBArticle | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editForm, setEditForm] = useState({ title: '', content: '', category: 'Technical', tags: '', account_id: '' })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [accountFilter, setAccountFilter] = useState('')

  // Fetch accounts for filter/selector
  async function fetchAccounts() {
    let query = supabase
      .from('accounts')
      .select('id, name')
      .eq('is_active', true)
      .order('name')
    // Non-admins see their company's accounts (including sibling channels)
    if (!isAdmin && companyAccountIds.length > 0) {
      query = query.in('id', companyAccountIds)
    }
    const { data } = await query
    if (data) setAccounts(data)
  }

  // Fetch articles from Supabase
  async function fetchArticles() {
    setLoading(true)
    setError(null)
    let query = supabase
      .from('kb_articles')
      .select('*')
      .order('updated_at', { ascending: false })

    // Non-admins: see articles for their company (all channels) or shared (account_id IS NULL)
    if (!isAdmin && companyAccountIds.length > 0) {
      query = query.or(companyAccountIds.map(id => `account_id.eq.${id}`).concat('account_id.is.null').join(','))
    }

    const { data, error: fetchError } = await query

    if (fetchError) {
      setError(fetchError.message)
      setLoading(false)
      return
    }

    setArticles((data as KBArticle[]) ?? [])
    setLoading(false)
  }

  useEffect(() => {
    fetchArticles()
    fetchAccounts()
  }, [])

  // Derived stats
  const totalArticles = articles.length
  const categoriesCount = new Set(articles.map((a) => a.category)).size
  const lastSyncTime = articles.reduce((latest, a) => {
    if (!a.last_synced_at) return latest
    return a.last_synced_at > latest ? a.last_synced_at : latest
  }, '')

  // Helper to get account name from id
  function getAccountName(accountId: string | null): string {
    if (!accountId) return 'General (Shared)'
    const acc = accounts.find(a => a.id === accountId)
    return acc ? acc.name : 'Unknown'
  }

  // Filtered articles
  const filteredArticles = useMemo(() => {
    return articles.filter((article) => {
      const matchesSearch =
        !searchQuery ||
        article.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        article.content.toLowerCase().includes(searchQuery.toLowerCase())
      const matchesCategory = !categoryFilter || article.category === categoryFilter
      const matchesAccount =
        !accountFilter ||
        (accountFilter === 'general' ? !article.account_id : article.account_id === accountFilter)
      return matchesSearch && matchesCategory && matchesAccount
    })
  }, [articles, searchQuery, categoryFilter, accountFilter, accounts])

  // Reset page on filter change
  useEffect(() => {
    setKbPage(1)
  }, [searchQuery, categoryFilter, accountFilter])

  const totalKbPages = Math.ceil(filteredArticles.length / KB_PAGE_SIZE)
  const paginatedArticles = useMemo(() => {
    const start = (kbPage - 1) * KB_PAGE_SIZE
    return filteredArticles.slice(start, start + KB_PAGE_SIZE)
  }, [filteredArticles, kbPage, KB_PAGE_SIZE])

  // Handlers
  function handleSyncNow() {
    setSyncing(true)
    // Re-fetch articles from Supabase as a "sync" action
    fetchArticles().finally(() => setSyncing(false))
  }

  async function handleToggleActive(id: string) {
    const article = articles.find((a) => a.id === id)
    if (!article) return

    const newValue = !article.is_active

    // Optimistic update
    setArticles((prev) =>
      prev.map((a) => (a.id === id ? { ...a, is_active: newValue } : a))
    )

    const { error: updateError } = await supabase
      .from('kb_articles')
      .update({ is_active: newValue })
      .eq('id', id)

    if (updateError) {
      console.error('Failed to toggle article active:', updateError.message)
      // Revert
      setArticles((prev) =>
        prev.map((a) => (a.id === id ? { ...a, is_active: !newValue } : a))
      )
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Are you sure you want to delete this article? This cannot be undone.')) {
      return
    }
    // Optimistic update
    const previousArticles = articles
    setArticles((prev) => prev.filter((a) => a.id !== id))

    const { error: deleteError } = await supabase
      .from('kb_articles')
      .delete()
      .eq('id', id)

    if (deleteError) {
      console.error('Failed to delete article:', deleteError.message)
      // Revert
      setArticles(previousArticles)
    }
  }

  function handleOpenArticle(article: KBArticle) {
    setSelectedArticle(article)
    setModalOpen(true)
  }

  function handleCloseModal() {
    setModalOpen(false)
    setSelectedArticle(null)
  }

  function handleOpenAdd() {
    setEditingId(null)
    setEditForm({ title: '', content: '', category: 'General', tags: '', account_id: !isAdmin && companyAccountIds.length > 0 ? companyAccountIds[0] : '' })
    setEditModalOpen(true)
  }

  function handleOpenEdit(article: KBArticle) {
    setEditingId(article.id)
    setEditForm({
      title: article.title,
      content: article.content,
      category: article.category || 'General',
      tags: (article.tags || []).join(', '),
      account_id: article.account_id || '',
    })
    setEditModalOpen(true)
    setModalOpen(false)
  }

  async function handleSaveArticle() {
    if (!editForm.title.trim() || !editForm.content.trim()) return
    setSaving(true)

    const tags = editForm.tags.split(',').map(t => t.trim()).filter(Boolean)
    const wordCount = editForm.content.split(/\s+/).length

    const accountId = editForm.account_id || null

    if (editingId) {
      // Update existing article
      const { error: updateError } = await supabase
        .from('kb_articles')
        .update({
          title: editForm.title.trim(),
          content: editForm.content.trim(),
          category: editForm.category,
          tags,
          word_count: wordCount,
          account_id: accountId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', editingId)

      if (updateError) {
        console.error('Failed to update article:', updateError.message)
      }
    } else {
      // Create new article
      const { error: insertError } = await supabase
        .from('kb_articles')
        .insert({
          title: editForm.title.trim(),
          content: editForm.content.trim(),
          category: editForm.category,
          tags,
          word_count: wordCount,
          account_id: accountId,
          is_active: true,
        })

      if (insertError) {
        console.error('Failed to create article:', insertError.message)
      }
    }

    setSaving(false)
    setEditModalOpen(false)
    fetchArticles()
  }

  if (loading) {
    return (
      <div className="flex h-80 items-center justify-center animate-fade-in">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-xl bg-blue-100 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-gray-700">Loading knowledge base</p>
            <p className="text-xs text-gray-400 mt-1">Fetching articles...</p>
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
        <p className="text-red-700 font-medium">Failed to load articles</p>
        <p className="text-sm text-gray-500 mt-1">{error}</p>
        <Button variant="secondary" className="mt-4" onClick={() => fetchArticles()}>
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
            <h1 className="text-2xl font-bold text-gray-900">Knowledge Base</h1>
            <p className="mt-1 text-sm text-gray-500">
              Manage articles used by AI to answer customer questions
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <Badge variant={syncing ? 'warning' : 'success'} size="md">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            {syncing ? 'Syncing...' : `Last synced ${lastSyncTime ? timeAgo(lastSyncTime) + ' ago' : 'never'}`}
          </Badge>
          <Button variant="secondary" size="sm" onClick={handleSyncNow} loading={syncing}>
            <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
            Sync Now
          </Button>
          <Button size="sm" onClick={handleOpenAdd}>
            <Plus className="h-4 w-4" />
            Add Article
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
              <BookOpen className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Total Articles</p>
              <p className="text-2xl font-bold text-gray-900">{totalArticles}</p>
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
              <Clock className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Last Sync</p>
              <p className="text-2xl font-bold text-gray-900">
                {lastSyncTime ? timeAgo(lastSyncTime) : 'Never'}
              </p>
            </div>
          </div>
        </Card>
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-100 text-orange-700">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Gap Analysis</p>
              <GapCount />
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
            placeholder="Search articles by title or content..."
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
            <option value="general">General (Shared)</option>
            {accounts.map(acc => (
              <option key={acc.id} value={acc.id}>{acc.name}</option>
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
      {/* Articles table                                                    */}
      {/* ----------------------------------------------------------------- */}
      <Card>
        {filteredArticles.length === 0 ? (
          <EmptyState
            icon={<FileQuestion className="h-12 w-12" />}
            title="No articles found"
            description={
              articles.length === 0
                ? 'No knowledge base articles have been created yet. Add your first article to get started.'
                : 'Try adjusting your search or filter criteria.'
            }
          />
        ) : (
          <><Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="hidden lg:table-cell">Preview</TableHead>
                <TableHead className="hidden md:table-cell">Source</TableHead>
                <TableHead className="hidden md:table-cell">Last Synced</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedArticles.map((article) => (
                <TableRow key={article.id}>
                  <TableCell>
                    <button
                      onClick={() => handleOpenArticle(article)}
                      className="text-left font-medium text-teal-700 hover:text-teal-900 hover:underline"
                    >
                      {article.title}
                    </button>
                  </TableCell>
                  <TableCell>
                    <span className={cn(
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                      article.account_id
                        ? 'bg-teal-50 text-teal-700'
                        : 'bg-gray-100 text-gray-600'
                    )}>
                      {getAccountName(article.account_id)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={getCategoryVariant(article.category)} size="sm">
                      {article.category}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden max-w-xs lg:table-cell">
                    <span className="text-sm text-gray-500">
                      {truncate(article.content, 150)}
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {article.source_url ? (
                      <a
                        href={article.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        GitHub
                      </a>
                    ) : (
                      <span className="text-sm text-gray-400">Manual</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap md:table-cell">
                    <span className="text-sm text-gray-500">
                      {article.last_synced_at
                        ? timeAgo(article.last_synced_at) + ' ago'
                        : 'Never'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Toggle
                      checked={article.is_active}
                      onChange={() => handleToggleActive(article.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleOpenEdit(article)}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                        title="Edit article"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(article.id)}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                        title="Delete article"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination
            currentPage={kbPage}
            totalPages={totalKbPages}
            totalItems={filteredArticles.length}
            pageSize={KB_PAGE_SIZE}
            onPageChange={setKbPage}
          />
          </>
        )}
      </Card>

      {/* ----------------------------------------------------------------- */}
      {/* Gap Analysis section                                              */}
      {/* ----------------------------------------------------------------- */}
      <Card title="Gap Analysis" description="Messages where AI had low confidence — potential KB gaps to fill">
        <GapAnalysis />
      </Card>

      {/* ----------------------------------------------------------------- */}
      {/* Article detail modal                                              */}
      {/* ----------------------------------------------------------------- */}
      <Modal
        open={modalOpen}
        onClose={handleCloseModal}
        title={selectedArticle?.title ?? 'Article Details'}
        className="sm:max-w-2xl"
        footer={
          <>
            <Button variant="secondary" onClick={handleCloseModal}>
              Close
            </Button>
            <Button onClick={() => selectedArticle && handleOpenEdit(selectedArticle)}>
              <Pencil className="h-4 w-4" />
              Edit Article
            </Button>
          </>
        }
      >
        {selectedArticle && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Badge variant="default" size="sm">
                {getAccountName(selectedArticle.account_id)}
              </Badge>
              <Badge variant={getCategoryVariant(selectedArticle.category)}>
                {selectedArticle.category}
              </Badge>
              <Badge variant={selectedArticle.is_active ? 'success' : 'default'}>
                {selectedArticle.is_active ? 'Active' : 'Inactive'}
              </Badge>
            </div>

            <div>
              <h4 className="mb-1 text-sm font-medium text-gray-500">Content</h4>
              <p className="text-sm leading-relaxed text-gray-700 whitespace-pre-wrap">
                {selectedArticle.content}
              </p>
            </div>

            {selectedArticle.source_url && (
              <div>
                <h4 className="mb-1 text-sm font-medium text-gray-500">Source</h4>
                <a
                  href={selectedArticle.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  {selectedArticle.source_url}
                </a>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 rounded-lg bg-gray-50 p-3">
              <div>
                <p className="text-xs text-gray-500">Created</p>
                <p className="text-sm font-medium text-gray-700">
                  {timeAgo(selectedArticle.created_at)} ago
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Last Synced</p>
                <p className="text-sm font-medium text-gray-700">
                  {selectedArticle.last_synced_at
                    ? timeAgo(selectedArticle.last_synced_at) + ' ago'
                    : 'Never'}
                </p>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Create/Edit Article Modal */}
      <Modal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        title={editingId ? 'Edit Article' : 'Add New Article'}
        className="sm:max-w-2xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveArticle} loading={saving} disabled={!editForm.title.trim() || !editForm.content.trim()}>
              <CheckCircle2 className="h-4 w-4" />
              {editingId ? 'Save Changes' : 'Create Article'}
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
              onChange={(e) => setEditForm(prev => ({ ...prev, title: e.target.value }))}
              placeholder="e.g., How to set up SIP trunking"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </div>
          {isAdmin && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Company *</label>
            <select
              value={editForm.account_id}
              onChange={(e) => setEditForm(prev => ({ ...prev, account_id: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="">General (Shared across all companies)</option>
              {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-400">
              Select which company this article belongs to. &quot;General&quot; articles are shared across all companies.
            </p>
          </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
            <select
              value={editForm.category}
              onChange={(e) => setEditForm(prev => ({ ...prev, category: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Content *</label>
            <textarea
              value={editForm.content}
              onChange={(e) => setEditForm(prev => ({ ...prev, content: e.target.value }))}
              placeholder="Write the article content that the AI will use to answer customer questions..."
              rows={10}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 resize-y min-h-[200px]"
            />
            <p className="mt-1 text-xs text-gray-400">
              {editForm.content.split(/\s+/).filter(Boolean).length} words
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tags</label>
            <input
              type="text"
              value={editForm.tags}
              onChange={(e) => setEditForm(prev => ({ ...prev, tags: e.target.value }))}
              placeholder="e.g., voip, sip, setup (comma-separated)"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
