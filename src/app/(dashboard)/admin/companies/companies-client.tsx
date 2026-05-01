'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Building2, Plus, AlertCircle } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/toast'

export interface CompanyRow {
  id: string
  name: string
  slug: string | null
  logo_url: string | null
  accent_color: string | null
  monthly_ai_budget_usd: number | null
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

export function CompaniesAdminClient({ initialCompanies }: { initialCompanies: CompanyRow[] }) {
  const router = useRouter()
  const { toast } = useToast()
  const [companies] = useState<CompanyRow[]>(initialCompanies)

  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createSlug, setCreateSlug] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

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

      <Card>
        {companies.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No companies yet"
            description="Create your first company to start onboarding tenants. Each company gets its own users, channels, branding, and AI budget."
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                Create your first company
              </Button>
            }
            hint="After creating, attach existing channels under the company detail page."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead className="hidden md:table-cell">Slug</TableHead>
                <TableHead className="text-right">Accounts</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="hidden lg:table-cell text-right">Spend (this month)</TableHead>
                <TableHead className="hidden lg:table-cell text-right">Budget</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {companies.map((c) => {
                const overBudget =
                  c.monthly_ai_budget_usd != null &&
                  c.monthly_ai_spend_usd > c.monthly_ai_budget_usd
                return (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer hover:bg-gray-50"
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
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {c.slug ? (
                        <span className="font-mono text-xs text-gray-600">{c.slug}</span>
                      ) : (
                        <span className="text-gray-400 italic text-xs">—</span>
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
    </div>
  )
}
