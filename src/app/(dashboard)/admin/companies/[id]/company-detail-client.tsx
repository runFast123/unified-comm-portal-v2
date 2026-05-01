'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Building2,
  Users as UsersIcon,
  Briefcase,
  ScrollText,
  Save,
  AlertCircle,
  UserPlus,
  Plug,
  PlugZap,
  ShieldCheck,
  ExternalLink,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Modal } from '@/components/ui/modal'
import { Toggle } from '@/components/ui/toggle'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import { timeAgo } from '@/lib/utils'

interface AccountRow {
  id: string
  name: string
  channel_type: string
  is_active: boolean
  company_id: string | null
}

interface UserRow {
  id: string
  email: string
  full_name: string | null
  role: string
  is_active: boolean
  account_id: string | null
  last_login_at: string | null
  created_at: string
}

interface AuditRow {
  id: string
  user_id: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  details: Record<string, unknown> | null
  created_at: string
  actor_email?: string | null
}

interface Company {
  id: string
  name: string
  slug: string | null
  logo_url: string | null
  accent_color: string | null
  monthly_ai_budget_usd: number | null
  settings: Record<string, unknown> | null
  default_email_signature: string | null
  created_at: string
  updated_at: string | null
}

export interface CompanyDetailData {
  company: Company
  accounts: AccountRow[]
  detachedAccounts: AccountRow[]
  users: UserRow[]
  audit: AuditRow[]
  canSuper: boolean
}

type TabKey = 'overview' | 'accounts' | 'users' | 'audit'

const ROLE_OPTIONS = [
  { value: 'company_admin', label: 'Company admin' },
  { value: 'company_member', label: 'Company member' },
  { value: 'admin', label: 'Admin (legacy)' },
  { value: 'reviewer', label: 'Reviewer (legacy)' },
  { value: 'viewer', label: 'Viewer (legacy)' },
]

export function CompanyDetailClient({ data }: { data: CompanyDetailData }) {
  const router = useRouter()
  const { toast } = useToast()
  const [tab, setTab] = useState<TabKey>('overview')

  const tabs: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: 'overview', label: 'Overview', icon: Building2 },
    { key: 'accounts', label: 'Accounts', icon: Briefcase },
    { key: 'users', label: 'Users', icon: UsersIcon },
    { key: 'audit', label: 'Audit log', icon: ScrollText },
  ]

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/companies"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-teal-700 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> All companies
        </Link>
        <div className="mt-2 flex items-center gap-3">
          {data.company.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.company.logo_url}
              alt=""
              className="h-10 w-10 rounded-md object-cover bg-gray-50 ring-1 ring-gray-200"
            />
          ) : (
            <div className="h-10 w-10 rounded-md bg-gray-100 ring-1 ring-gray-200 flex items-center justify-center text-sm font-semibold text-gray-600">
              {data.company.name.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{data.company.name}</h1>
            <p className="text-sm text-gray-500">
              {data.company.slug ? <span className="font-mono">{data.company.slug}</span> : 'No slug'}
              {' · '}
              <span>{data.accounts.length} accounts</span>
              {' · '}
              <span>{data.users.length} users</span>
            </p>
          </div>
          {data.canSuper && (
            <Badge variant="info" className="ml-auto">
              <ShieldCheck className="mr-1 h-3 w-3" /> Super-admin view
            </Badge>
          )}
        </div>
      </div>

      <div className="border-b border-gray-200">
        <nav className="-mb-px flex flex-wrap gap-2" aria-label="Tabs">
          {tabs.map((t) => {
            const Icon = t.icon
            const active = tab === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'border-teal-600 text-teal-700'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                }`}
              >
                <Icon className="h-4 w-4" />
                {t.label}
              </button>
            )
          })}
        </nav>
      </div>

      {tab === 'overview' && (
        <OverviewTab
          company={data.company}
          onSaved={(c) => {
            // Re-fetch the page so all tabs see the latest state.
            router.refresh()
            toast.success(`Saved ${c.name}`)
          }}
        />
      )}

      {tab === 'accounts' && (
        <AccountsTab
          companyId={data.company.id}
          accounts={data.accounts}
          detachedAccounts={data.detachedAccounts}
          canSuper={data.canSuper}
          onChanged={() => router.refresh()}
        />
      )}

      {tab === 'users' && (
        <UsersTab
          companyId={data.company.id}
          users={data.users}
          accounts={data.accounts}
          onChanged={() => router.refresh()}
        />
      )}

      {tab === 'audit' && <AuditTab audit={data.audit} />}
    </div>
  )
}

// ─── Overview tab ────────────────────────────────────────────────────

function OverviewTab({
  company,
  onSaved,
}: {
  company: Company
  onSaved: (c: Company) => void
}) {
  const { toast } = useToast()
  const [name, setName] = useState(company.name)
  const [slug, setSlug] = useState(company.slug ?? '')
  const [logoUrl, setLogoUrl] = useState(company.logo_url ?? '')
  const [accentColor, setAccentColor] = useState(company.accent_color ?? '')
  const [budget, setBudget] = useState(
    company.monthly_ai_budget_usd != null ? String(company.monthly_ai_budget_usd) : '',
  )
  const [settingsText, setSettingsText] = useState(
    company.settings ? JSON.stringify(company.settings, null, 2) : '{}',
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)

    let parsedSettings: Record<string, unknown> | null = null
    try {
      parsedSettings = settingsText.trim() ? JSON.parse(settingsText) : {}
      if (typeof parsedSettings !== 'object' || Array.isArray(parsedSettings)) {
        throw new Error('settings must be a JSON object')
      }
    } catch (err) {
      setError(`Invalid settings JSON: ${err instanceof Error ? err.message : 'parse failed'}`)
      setSaving(false)
      return
    }

    const body: Record<string, unknown> = {
      name,
      slug: slug.trim() || null,
      logo_url: logoUrl.trim() || null,
      accent_color: accentColor.trim() || null,
      settings: parsedSettings,
    }
    if (budget.trim() === '') {
      body.monthly_ai_budget_usd = null
    } else {
      const num = Number(budget)
      if (!Number.isFinite(num) || num < 0) {
        setError('Budget must be a non-negative number')
        setSaving(false)
        return
      }
      body.monthly_ai_budget_usd = num
    }

    try {
      const res = await fetch(`/api/admin/companies/${company.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error ?? 'Failed to save')
        setSaving(false)
        return
      }
      onSaved(data.company as Company)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setSaving(false)
    }
  }, [name, slug, logoUrl, accentColor, budget, settingsText, company.id, onSaved])

  return (
    <Card className="p-6">
      <div className="space-y-5">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 text-red-600" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            label="Slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="acme"
          />
        </div>
        <Input
          label="Logo URL"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder="https://..."
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Accent color</label>
            <div className="flex items-center gap-2">
              <Input
                value={accentColor}
                onChange={(e) => setAccentColor(e.target.value)}
                placeholder="#0e7490"
                className="font-mono"
              />
              {accentColor && (
                <span
                  className="h-9 w-9 rounded-md ring-1 ring-gray-200 shrink-0"
                  style={{ backgroundColor: accentColor }}
                  aria-hidden="true"
                />
              )}
            </div>
          </div>
          <Input
            label="Monthly AI budget (USD)"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="500"
            type="number"
            step="0.01"
            min="0"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Settings (JSON)</label>
          <textarea
            value={settingsText}
            onChange={(e) => setSettingsText(e.target.value)}
            rows={6}
            className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs text-gray-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
          />
        </div>
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="text-sm">
            <p className="font-medium text-gray-700">Default email signature</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {company.default_email_signature
                ? `${company.default_email_signature.slice(0, 80)}${
                    company.default_email_signature.length > 80 ? '...' : ''
                  }`
                : 'Not configured'}
            </p>
          </div>
          <Link href="/admin/company-signatures" className="inline-flex items-center gap-1 text-sm text-teal-700 hover:text-teal-800">
            Manage <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={handleSave} loading={saving} disabled={saving}>
            <Save className="h-4 w-4" /> Save changes
          </Button>
        </div>
      </div>
    </Card>
  )
}

// ─── Accounts tab ────────────────────────────────────────────────────

function AccountsTab({
  companyId,
  accounts,
  detachedAccounts,
  canSuper,
  onChanged,
}: {
  companyId: string
  accounts: AccountRow[]
  detachedAccounts: AccountRow[]
  canSuper: boolean
  onChanged: () => void
}) {
  const { toast } = useToast()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachId, setAttachId] = useState('')
  const [attaching, setAttaching] = useState(false)

  const detach = useCallback(
    async (accountId: string) => {
      if (!confirm('Detach this account from the company?')) return
      setBusyId(accountId)
      try {
        const res = await fetch(
          `/api/admin/companies/${companyId}/accounts/${accountId}/detach`,
          { method: 'POST' },
        )
        const data = await res.json()
        if (!res.ok) {
          toast.error(data?.error ?? 'Detach failed')
        } else {
          toast.success('Account detached')
          onChanged()
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      } finally {
        setBusyId(null)
      }
    },
    [companyId, onChanged, toast],
  )

  const attach = useCallback(async () => {
    if (!attachId) return
    setAttaching(true)
    try {
      const res = await fetch(
        `/api/admin/companies/${companyId}/accounts/${attachId}/attach`,
        { method: 'POST' },
      )
      const data = await res.json()
      if (!res.ok) {
        toast.error(data?.error ?? 'Attach failed')
      } else {
        toast.success('Account attached')
        setAttachOpen(false)
        setAttachId('')
        onChanged()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error')
    } finally {
      setAttaching(false)
    }
  }, [attachId, companyId, onChanged, toast])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{accounts.length} accounts in this company.</p>
        <div className="flex items-center gap-2">
          {canSuper && detachedAccounts.length > 0 && (
            <Button variant="secondary" onClick={() => setAttachOpen(true)}>
              <PlugZap className="h-4 w-4" /> Attach existing account
            </Button>
          )}
          <Link href="/admin/accounts" className="inline-flex">
            <Button variant="secondary">
              <Plug className="h-4 w-4" /> Add account
            </Button>
          </Link>
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4}>
                  <p className="py-8 text-center text-sm text-gray-500">
                    No accounts yet. Use the existing account creation flow under{' '}
                    <Link href="/admin/accounts" className="text-teal-700 hover:underline">
                      /admin/accounts
                    </Link>{' '}
                    and attach the result here.
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              accounts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link href={`/accounts/${a.id}`} className="font-medium text-gray-900 hover:text-teal-700">
                      {a.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="default">{a.channel_type}</Badge>
                  </TableCell>
                  <TableCell>
                    {a.is_active ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="default">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === a.id}
                      onClick={() => detach(a.id)}
                    >
                      Detach
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Modal
        open={attachOpen}
        onClose={() => {
          setAttachOpen(false)
          setAttachId('')
        }}
        title="Attach existing account"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAttachOpen(false)} disabled={attaching}>
              Cancel
            </Button>
            <Button onClick={attach} disabled={!attachId || attaching} loading={attaching}>
              Attach
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Choose a currently-detached account (no company assigned) to attach to this company.
          </p>
          <Select
            label="Account"
            value={attachId}
            onChange={(e) => setAttachId(e.target.value)}
            options={[
              { value: '', label: '— Select account —' },
              ...detachedAccounts.map((a) => ({
                value: a.id,
                label: `${a.name} (${a.channel_type})`,
              })),
            ]}
          />
        </div>
      </Modal>
    </div>
  )
}

// ─── Users tab ───────────────────────────────────────────────────────

function UsersTab({
  companyId,
  users,
  accounts,
  onChanged,
}: {
  companyId: string
  users: UserRow[]
  accounts: AccountRow[]
  onChanged: () => void
}) {
  const { toast } = useToast()
  const [savingId, setSavingId] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState('company_member')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  const updateUser = useCallback(
    async (userId: string, patch: Record<string, unknown>) => {
      setSavingId(userId)
      try {
        const res = await fetch(
          `/api/admin/companies/${companyId}/users/${userId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          },
        )
        const data = await res.json()
        if (!res.ok) {
          toast.error(data?.error ?? 'Update failed')
        } else {
          toast.success('Updated')
          onChanged()
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      } finally {
        setSavingId(null)
      }
    },
    [companyId, onChanged, toast],
  )

  const handleInvite = useCallback(async () => {
    if (!inviteEmail.trim()) return
    setInviting(true)
    setInviteError(null)
    try {
      const res = await fetch(`/api/admin/companies/${companyId}/users/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: inviteEmail.trim(),
          full_name: inviteName.trim() || null,
          role: inviteRole,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setInviteError(data?.error ?? 'Invite failed')
        setInviting(false)
        return
      }
      if (data.invite_warning) {
        toast.success(`User added (note: ${data.invite_warning})`)
      } else {
        toast.success('User invited')
      }
      setInviteOpen(false)
      setInviteEmail('')
      setInviteName('')
      setInviteRole('company_member')
      onChanged()
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setInviting(false)
    }
  }, [inviteEmail, inviteName, inviteRole, companyId, onChanged, toast])

  const accountName: Record<string, string> = {}
  for (const a of accounts) accountName[a.id] = a.name

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{users.length} users in this company.</p>
        <Button onClick={() => setInviteOpen(true)}>
          <UserPlus className="h-4 w-4" /> Invite user
        </Button>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="hidden lg:table-cell">Last login</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <p className="py-8 text-center text-sm text-gray-500">
                    No users yet. Click <strong>Invite user</strong> to get started.
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              users.map((u) => {
                const saving = savingId === u.id
                return (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="font-medium text-gray-900">{u.email}</div>
                      {u.full_name && <div className="text-xs text-gray-500">{u.full_name}</div>}
                    </TableCell>
                    <TableCell>
                      <Select
                        className="min-w-[160px]"
                        value={ROLE_OPTIONS.find((r) => r.value === u.role) ? u.role : 'company_member'}
                        disabled={saving}
                        onChange={(e) => updateUser(u.id, { role: e.target.value })}
                        options={ROLE_OPTIONS}
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        className="min-w-[160px]"
                        value={u.account_id ?? ''}
                        disabled={saving}
                        onChange={(e) =>
                          updateUser(u.id, { account_id: e.target.value || null })
                        }
                        options={[
                          { value: '', label: '— No account —' },
                          ...accounts.map((a) => ({ value: a.id, label: a.name })),
                        ]}
                      />
                    </TableCell>
                    <TableCell>
                      <Toggle
                        checked={u.is_active}
                        onChange={(val) => updateUser(u.id, { is_active: val })}
                        disabled={saving}
                      />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-sm text-gray-500">
                      {u.last_login_at ? timeAgo(u.last_login_at) : <span className="text-gray-400 italic">Never</span>}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <Modal
        open={inviteOpen}
        onClose={() => {
          setInviteOpen(false)
          setInviteError(null)
        }}
        title="Invite user"
        footer={
          <>
            <Button variant="secondary" onClick={() => setInviteOpen(false)} disabled={inviting}>
              Cancel
            </Button>
            <Button onClick={handleInvite} disabled={!inviteEmail.trim() || inviting} loading={inviting}>
              <UserPlus className="h-4 w-4" /> Send invite
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {inviteError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 text-red-600" />
              <p className="text-sm text-red-700">{inviteError}</p>
            </div>
          )}
          <Input
            label="Email"
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="user@company.com"
            autoFocus
          />
          <Input
            label="Full name (optional)"
            value={inviteName}
            onChange={(e) => setInviteName(e.target.value)}
            placeholder="Jane Doe"
          />
          <Select
            label="Role"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
            options={ROLE_OPTIONS}
          />
        </div>
      </Modal>
    </div>
  )
}

// ─── Audit tab ───────────────────────────────────────────────────────

function AuditTab({ audit }: { audit: AuditRow[] }) {
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Entity</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {audit.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5}>
                <p className="py-8 text-center text-sm text-gray-500">
                  No audit entries yet for this company.
                </p>
              </TableCell>
            </TableRow>
          ) : (
            audit.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="text-xs text-gray-500 whitespace-nowrap">
                  {timeAgo(row.created_at)}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs text-gray-700">{row.action}</span>
                </TableCell>
                <TableCell className="text-xs text-gray-600">
                  {row.actor_email ?? <span className="italic text-gray-400">system</span>}
                </TableCell>
                <TableCell className="text-xs text-gray-600">
                  {row.entity_type ? `${row.entity_type}` : ''}
                </TableCell>
                <TableCell className="max-w-md">
                  {row.details ? (
                    <pre className="text-[11px] text-gray-600 overflow-x-auto whitespace-pre-wrap break-words">
                      {JSON.stringify(row.details)}
                    </pre>
                  ) : (
                    <span className="text-gray-400 italic text-xs">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Card>
  )
}
