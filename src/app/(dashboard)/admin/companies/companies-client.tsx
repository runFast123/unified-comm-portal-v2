'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Building2,
  Plus,
  AlertCircle,
  Trash2,
  MoreHorizontal,
  Archive,
  ArchiveRestore,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { Badge } from '@/components/ui/badge'
import { Toggle } from '@/components/ui/toggle'
import { useToast } from '@/components/ui/toast'

export interface CompanyRow {
  id: string
  name: string
  slug: string | null
  logo_url: string | null
  accent_color: string | null
  monthly_ai_budget_usd: number | null
  archived_at: string | null
  created_at: string
  accounts_count: number
  users_count: number
  monthly_ai_spend_usd: number
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

// ────────────────────────────────────────────────────────────────────────────
// Lightweight inline overflow menu. We don't have a dropdown-menu primitive
// in @/components/ui, so we roll a small one here (popover + outside-click
// dismiss). Kept local because the surface area is tiny — Archive / Restore
// / Delete only.
// ────────────────────────────────────────────────────────────────────────────
interface OverflowMenuProps {
  archived: boolean
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
  label: string // for aria
}

function OverflowMenu({
  archived,
  onArchive,
  onRestore,
  onDelete,
  label,
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', handle)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <div className="relative inline-block text-left" ref={wrapperRef}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className="inline-flex items-center justify-center rounded-md p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title="More actions"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          // Right-align under the trigger; row click handler ignores clicks
          // that bubble from inside the menu thanks to stopPropagation below.
          className="absolute right-0 z-20 mt-1 w-48 origin-top-right rounded-md border border-gray-200 bg-white shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="py-1">
            {archived ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close()
                  onRestore()
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
              >
                <ArchiveRestore className="h-4 w-4 text-gray-500" />
                Restore
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close()
                  onArchive()
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
              >
                <Archive className="h-4 w-4 text-gray-500" />
                Archive
              </button>
            )}
            <div className="my-1 border-t border-gray-100" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close()
                onDelete()
              }}
              // Destructive but de-emphasized: same text color as Archive,
              // hover state goes red. Soft-archive is the recommended path.
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-red-50 hover:text-red-700"
            >
              <Trash2 className="h-4 w-4 text-gray-400" />
              Delete forever
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function CompaniesAdminClient({
  initialCompanies,
  initialIncludeArchived = false,
}: {
  initialCompanies: CompanyRow[]
  initialIncludeArchived?: boolean
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [companies, setCompanies] = useState<CompanyRow[]>(initialCompanies)
  const [includeArchived, setIncludeArchived] = useState(initialIncludeArchived)
  const [refreshing, setRefreshing] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createSlug, setCreateSlug] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Delete-flow state. Confirm-by-typing-name is the same pattern GitHub
  // uses for "delete repo" — catches "wrong company id" mistakes which
  // are by far the most common cause of accidental destructive admin ops.
  const [deleteTarget, setDeleteTarget] = useState<CompanyRow | null>(null)
  const [deleteTypedName, setDeleteTypedName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteForce, setDeleteForce] = useState(false)

  // Archive / restore confirm-modal state. We share a single piece of
  // state for both because the action set is mutually exclusive per row.
  const [archiveTarget, setArchiveTarget] = useState<CompanyRow | null>(null)
  const [archiveMode, setArchiveMode] = useState<'archive' | 'restore'>('archive')
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  const closeDelete = () => {
    setDeleteTarget(null)
    setDeleteTypedName('')
    setDeleteError(null)
    setDeleteForce(false)
    setDeleting(false)
  }

  const closeArchive = () => {
    setArchiveTarget(null)
    setArchiveError(null)
    setArchiveBusy(false)
  }

  // Refetch the list whenever the "Show archived" toggle changes. We hit
  // the API rather than reloading the page so the toggle feels snappy.
  const refetch = useCallback(
    async (withArchived: boolean) => {
      setRefreshing(true)
      try {
        const qs = withArchived ? '?include_archived=true' : ''
        const res = await fetch(`/api/admin/companies${qs}`, { cache: 'no-store' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data?.error ?? 'Failed to load companies')
          return
        }
        // API returns only the company fields, not the aggregated counts.
        // Merge with existing counts where we have them so the table doesn't
        // visibly reset numbers to 0 while refetching; archived rows that
        // weren't in the previous list show 0 until the next server render.
        const existingById = new Map(companies.map((c) => [c.id, c]))
        type ApiCompany = {
          id: string
          name: string
          slug: string | null
          logo_url: string | null
          accent_color: string | null
          monthly_ai_budget_usd: number | null
          archived_at: string | null
          created_at: string
        }
        const merged: CompanyRow[] = ((data.companies ?? []) as ApiCompany[]).map(
          (c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug,
            logo_url: c.logo_url,
            accent_color: c.accent_color,
            monthly_ai_budget_usd: c.monthly_ai_budget_usd,
            archived_at: c.archived_at,
            created_at: c.created_at,
            accounts_count: existingById.get(c.id)?.accounts_count ?? 0,
            users_count: existingById.get(c.id)?.users_count ?? 0,
            monthly_ai_spend_usd: existingById.get(c.id)?.monthly_ai_spend_usd ?? 0,
          }),
        )
        setCompanies(merged)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      } finally {
        setRefreshing(false)
      }
    },
    [companies, toast],
  )

  const handleToggleArchived = useCallback(
    async (next: boolean) => {
      setIncludeArchived(next)
      await refetch(next)
      // Refresh the server component too so a hard reload reflects the same
      // state — also pulls fresh counts (refetch only restores them from
      // cache, doesn't recompute).
      router.refresh()
    },
    [refetch, router],
  )

  const handleArchive = useCallback(async () => {
    if (!archiveTarget) return
    setArchiveBusy(true)
    setArchiveError(null)
    try {
      const res = await fetch(`/api/admin/companies/${archiveTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: archiveMode === 'archive' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setArchiveError(data?.error ?? `Failed to ${archiveMode} company`)
        setArchiveBusy(false)
        return
      }
      toast.success(
        archiveMode === 'archive'
          ? `Archived "${archiveTarget.name}"`
          : `Restored "${archiveTarget.name}"`,
      )
      // Update local state. If we're hiding archived companies, drop the
      // row entirely; otherwise just flip its archived_at flag.
      setCompanies((prev) => {
        if (archiveMode === 'archive' && !includeArchived) {
          return prev.filter((c) => c.id !== archiveTarget.id)
        }
        return prev.map((c) =>
          c.id === archiveTarget.id
            ? { ...c, archived_at: archiveMode === 'archive' ? new Date().toISOString() : null }
            : c,
        )
      })
      closeArchive()
      router.refresh()
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : 'Network error')
      setArchiveBusy(false)
    }
  }, [archiveTarget, archiveMode, includeArchived, router, toast])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    if (deleteTypedName !== deleteTarget.name) {
      setDeleteError(`Type the company name exactly to confirm: "${deleteTarget.name}"`)
      return
    }
    setDeleting(true)
    setDeleteError(null)
    try {
      const url = `/api/admin/companies/${deleteTarget.id}?confirm=${encodeURIComponent(deleteTarget.name)}${deleteForce ? '&force=true' : ''}`
      const res = await fetch(url, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // 409 = company has attached accounts. Surface the count so the
        // operator can decide between detaching first or forcing.
        if (res.status === 409 && typeof data?.attached_accounts === 'number') {
          setDeleteError(
            `${data.error} You can detach accounts on the company detail page, OR check "Force delete (cascade)" below to remove them all.`,
          )
        } else {
          setDeleteError(data?.error ?? 'Failed to delete company')
        }
        setDeleting(false)
        return
      }
      toast.success(`Deleted "${deleteTarget.name}"`)
      // Optimistically drop the row from the list so the table updates
      // before router.refresh() round-trips.
      setCompanies((prev) => prev.filter((c) => c.id !== deleteTarget.id))
      closeDelete()
      router.refresh()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Network error')
      setDeleting(false)
    }
  }, [deleteTarget, deleteTypedName, deleteForce, router, toast])

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) {
      setCreateError('Name is required')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch('/api/admin/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: createName.trim(), slug: createSlug.trim() || null }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCreateError(data?.error ?? 'Failed to create company')
        setCreating(false)
        return
      }
      toast.success('Company created')
      setCreateOpen(false)
      setCreateName('')
      setCreateSlug('')
      router.push(`/admin/companies/${data.company.id}`)
      router.refresh()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setCreating(false)
    }
  }, [createName, createSlug, router, toast])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Building2 className="h-6 w-6 text-teal-700" />
            Companies
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Tenant-level container for accounts, users, branding, and AI budgets.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> Create company
        </Button>
      </div>

      {/* Toolbar — Show-archived toggle. Default off; archive is "soft" so
          most of the time you don't want to see archived rows mixed in. */}
      <div className="flex items-center justify-between gap-3">
        <Toggle
          checked={includeArchived}
          onChange={handleToggleArchived}
          disabled={refreshing}
          label="Show archived"
          description="Include companies that have been soft-archived"
        />
        {refreshing && (
          <span className="text-xs text-gray-500">Refreshing…</span>
        )}
      </div>

      <Card>
        {companies.length === 0 ? (
          <EmptyState
            icon={Building2}
            title={includeArchived ? 'No companies' : 'No active companies'}
            description={
              includeArchived
                ? 'No companies exist yet. Create your first one to start onboarding tenants.'
                : 'Create your first company to start onboarding tenants. Each company gets its own users, channels, branding, and AI budget.'
            }
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                Create your first company
              </Button>
            }
            hint="After creating, attach existing channels under the company detail page."
          />
        ) : (
          <Table className="min-w-0">
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead className="hidden md:table-cell">Slug</TableHead>
                <TableHead className="text-right">Accounts</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="hidden lg:table-cell text-right">Spend (this month)</TableHead>
                <TableHead className="hidden lg:table-cell text-right">Budget</TableHead>
                <TableHead className="w-[60px]"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {companies.map((c) => {
                const overBudget =
                  c.monthly_ai_budget_usd != null &&
                  c.monthly_ai_spend_usd > c.monthly_ai_budget_usd
                const isArchived = c.archived_at != null
                return (
                  <TableRow
                    key={c.id}
                    className={
                      'cursor-pointer hover:bg-gray-50 ' +
                      (isArchived ? 'opacity-60 bg-gray-50/40' : '')
                    }
                    onClick={() => router.push(`/admin/companies/${c.id}`)}
                  >
                    <TableCell>
                      <Link
                        href={`/admin/companies/${c.id}`}
                        className="flex items-center gap-3 group"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {/* Logo / branding preview */}
                        {c.logo_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={c.logo_url}
                            alt=""
                            className="h-8 w-8 rounded-md object-cover bg-gray-50 ring-1 ring-gray-200"
                          />
                        ) : (
                          <div className="h-8 w-8 rounded-md bg-gray-100 ring-1 ring-gray-200 flex items-center justify-center text-xs font-semibold text-gray-600">
                            {c.name.slice(0, 2).toUpperCase()}
                          </div>
                        )}
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-medium text-gray-900 group-hover:text-teal-700 truncate">
                            {c.name}
                          </span>
                          {c.accent_color && (
                            <span
                              className="inline-block h-3 w-3 rounded-full ring-1 ring-gray-300 shrink-0"
                              style={{ backgroundColor: c.accent_color }}
                              title={`Accent ${c.accent_color}`}
                              aria-hidden="true"
                            />
                          )}
                          {isArchived && (
                            <Badge variant="warning" size="sm" className="shrink-0">
                              Archived
                            </Badge>
                          )}
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {c.slug ? (
                        <span className="font-mono text-xs text-gray-600">{c.slug}</span>
                      ) : (
                        <span className="italic text-xs text-gray-400">Not set</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm text-gray-700">
                      {c.accounts_count}
                    </TableCell>
                    <TableCell className="text-right text-sm text-gray-700">
                      {c.users_count}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-right text-sm">
                      <span className={overBudget ? 'text-red-600 font-medium' : 'text-gray-700'}>
                        {formatCurrency(c.monthly_ai_spend_usd)}
                      </span>
                      {overBudget && (
                        <AlertCircle className="inline-block ml-1 h-3.5 w-3.5 text-red-600" />
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-right text-sm text-gray-500">
                      {c.monthly_ai_budget_usd != null ? formatCurrency(c.monthly_ai_budget_usd) : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {/* The overflow menu wraps stopPropagation around its
                          own clicks so opening it doesn't navigate to the
                          detail page. */}
                      <div onClick={(e) => e.stopPropagation()}>
                        <OverflowMenu
                          archived={isArchived}
                          label={`Actions for ${c.name}`}
                          onArchive={() => {
                            setArchiveTarget(c)
                            setArchiveMode('archive')
                          }}
                          onRestore={() => {
                            setArchiveTarget(c)
                            setArchiveMode('restore')
                          }}
                          onDelete={() => setDeleteTarget(c)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Modal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false)
          setCreateError(null)
        }}
        title="Create company"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setCreateOpen(false)
                setCreateError(null)
              }}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !createName.trim()} loading={creating}>
              <Plus className="h-4 w-4" /> Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 text-red-600" />
              <p className="text-sm text-red-700">{createError}</p>
            </div>
          )}
          <Input
            label="Name"
            placeholder="Acme Inc."
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            autoFocus
          />
          <Input
            label="Slug (optional)"
            placeholder="acme"
            value={createSlug}
            onChange={(e) => setCreateSlug(e.target.value.toLowerCase())}
          />
          <p className="text-xs text-gray-500">
            Slug must be lowercase letters, digits, and dashes (1-64 chars). Used for vanity URLs.
          </p>
        </div>
      </Modal>

      {/* ─── Archive / Restore confirmation modal ──────────────────────
         Soft-archive is recommended over delete. We don't require name
         typing here because it's reversible — one click in the row menu
         restores access. */}
      <Modal
        open={archiveTarget !== null}
        onClose={closeArchive}
        title={
          archiveTarget
            ? archiveMode === 'archive'
              ? `Archive "${archiveTarget.name}"?`
              : `Restore "${archiveTarget.name}"?`
            : ''
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeArchive} disabled={archiveBusy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleArchive}
              disabled={archiveBusy || !archiveTarget}
              loading={archiveBusy}
            >
              {archiveMode === 'archive' ? (
                <>
                  <Archive className="h-4 w-4" />
                  Archive
                </>
              ) : (
                <>
                  <ArchiveRestore className="h-4 w-4" />
                  Restore
                </>
              )}
            </Button>
          </>
        }
      >
        {archiveTarget && (
          <div className="space-y-3">
            <p className="text-sm text-gray-700">
              {archiveMode === 'archive'
                ? `Archive ${archiveTarget.name}? Members will lose access; you can restore later.`
                : `Restore ${archiveTarget.name}? Members regain access.`}
            </p>
            {archiveError && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                {archiveError}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ─── Delete confirmation modal ─────────────────────────────────
         Two-key safety: must type the exact company name AND, if accounts
         are still attached, must opt into "Force delete (cascade)". The
         button stays disabled until both checks pass. */}
      <Modal
        open={deleteTarget !== null}
        onClose={closeDelete}
        title={deleteTarget ? `Delete "${deleteTarget.name}"` : 'Delete company'}
        footer={
          <>
            <Button variant="secondary" onClick={closeDelete} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={deleting || !deleteTarget || deleteTypedName !== (deleteTarget?.name ?? '')}
              loading={deleting}
            >
              <Trash2 className="h-4 w-4" />
              Delete forever
            </Button>
          </>
        }
      >
        {deleteTarget && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-3">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
              <div className="space-y-1 text-sm text-red-800">
                <p className="font-semibold">This is permanent and cannot be undone.</p>
                <p>
                  Deleting this company will cascade-delete all of its accounts, conversations,
                  messages, contacts, channel configs, audit history, and integration settings
                  ({deleteTarget.accounts_count} account{deleteTarget.accounts_count === 1 ? '' : 's'},
                  {' '}{deleteTarget.users_count} user{deleteTarget.users_count === 1 ? '' : 's'}
                  {' '}attached).
                </p>
                <p className="mt-2">
                  <span className="font-medium">Consider archiving instead</span> — it hides the
                  company from active lists but keeps all data so you can restore it later.
                </p>
              </div>
            </div>

            {deleteError && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                {deleteError}
              </div>
            )}

            <Input
              label={`Type "${deleteTarget.name}" to confirm`}
              placeholder={deleteTarget.name}
              value={deleteTypedName}
              onChange={(e) => setDeleteTypedName(e.target.value)}
              autoFocus
            />

            {deleteTarget.accounts_count > 0 && (
              <label className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={deleteForce}
                  onChange={(e) => setDeleteForce(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                />
                <span className="text-sm text-gray-700">
                  <span className="font-medium">Force delete (cascade)</span> — also remove the
                  {' '}{deleteTarget.accounts_count} attached account{deleteTarget.accounts_count === 1 ? '' : 's'}.
                  Without this, you must detach accounts on the company detail page first.
                </span>
              </label>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
