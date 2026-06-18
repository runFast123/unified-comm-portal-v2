'use client'

import { useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
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
  CheckCircle2,
  Circle,
  Upload,
  Trash2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
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
import { useConfirm } from '@/components/ui/confirm-dialog'
import { timeAgo } from '@/lib/utils'
import { TenantSettingsLinks } from '@/components/dashboard/tenant-settings-links'

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
  archived_at: string | null
  created_at: string
  updated_at: string | null
}

export type OnboardingStepId =
  | 'add_account'
  | 'configure_credentials'
  | 'invite_teammate'
  | 'first_reply'

export interface OnboardingStep {
  id: OnboardingStepId
  complete: boolean
}

export interface OnboardingStatus {
  steps: OnboardingStep[]
  allComplete: boolean
}

export interface CompanyDetailData {
  company: Company
  accounts: AccountRow[]
  detachedAccounts: AccountRow[]
  users: UserRow[]
  audit: AuditRow[]
  canSuper: boolean
  onboarding: OnboardingStatus
}

const ONBOARDING_LABELS: Record<OnboardingStepId, string> = {
  add_account: 'At least one channel connected',
  configure_credentials: 'Channel credentials configured',
  invite_teammate: 'At least one company_admin user',
  first_reply: 'At least one outbound message sent',
}

type TabKey = 'overview' | 'accounts' | 'users' | 'audit'

const ROLE_OPTIONS = [
  { value: 'company_admin', label: 'Company admin' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'company_member', label: 'Company member' },
  { value: 'admin', label: 'Admin (legacy)' },
  { value: 'reviewer', label: 'Reviewer (legacy)' },
  { value: 'viewer', label: 'Viewer (legacy)' },
]

export function CompanyDetailClient({ data }: { data: CompanyDetailData }) {
  const router = useRouter()
  const { toast } = useToast()
  const [tab, setTab] = useState<TabKey>('overview')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState(false)

  const tabs: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: 'overview', label: 'Overview', icon: Building2 },
    { key: 'accounts', label: 'Accounts', icon: Briefcase },
    { key: 'users', label: 'Users', icon: UsersIcon },
    { key: 'audit', label: 'Audit log', icon: ScrollText },
  ]

  const isArchived = data.company.archived_at !== null

  const toggleArchive = useCallback(async () => {
    setArchiveBusy(true)
    try {
      const res = await fetch(`/api/admin/companies/${data.company.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: !isArchived }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body?.error ?? (isArchived ? 'Restore failed' : 'Archive failed'))
        return
      }
      toast.success(isArchived ? 'Company restored' : 'Company archived')
      setArchiveOpen(false)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error')
    } finally {
      setArchiveBusy(false)
    }
  }, [data.company.id, isArchived, router, toast])

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
          <div className="ml-auto flex items-center gap-2">
            {isArchived && (
              <Badge variant="warning">
                <Archive className="mr-1 h-3 w-3" /> Archived
              </Badge>
            )}
            {!isArchived && !data.onboarding.allComplete && (
              <Badge variant="warning">
                <Sparkles className="mr-1 h-3 w-3" /> Setup in progress
              </Badge>
            )}
            {data.canSuper && (
              <Badge variant="info">
                <ShieldCheck className="mr-1 h-3 w-3" /> Super-admin view
              </Badge>
            )}
            {data.canSuper && (
              <Button
                variant={isArchived ? 'secondary' : 'danger'}
                size="sm"
                onClick={() => setArchiveOpen(true)}
              >
                {isArchived ? (
                  <>
                    <ArchiveRestore className="h-4 w-4" /> Restore
                  </>
                ) : (
                  <>
                    <Archive className="h-4 w-4" /> Archive
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>

      {isArchived && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <Archive className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <div className="text-sm">
            <p className="font-medium text-amber-900">This company is archived.</p>
            <p className="text-amber-800">
              Members are locked out. Restore to re-enable.
            </p>
          </div>
        </div>
      )}

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
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="xl:col-span-2 space-y-6">
            {!data.onboarding.allComplete && (
              <OnboardingBanner status={data.onboarding} />
            )}
            <OverviewTab
              company={data.company}
              canSuper={data.canSuper}
              onSaved={(c) => {
                // Re-fetch the page so all tabs see the latest state.
                router.refresh()
                toast.success(`Saved ${c.name}`)
              }}
            />
          </div>
          <div>
            <TenantSettingsLinks companyId={data.company.id} />
          </div>
        </div>
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

      <Modal
        open={archiveOpen}
        onClose={() => !archiveBusy && setArchiveOpen(false)}
        title={isArchived ? 'Restore company?' : 'Archive company?'}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setArchiveOpen(false)}
              disabled={archiveBusy}
            >
              Cancel
            </Button>
            <Button
              variant={isArchived ? 'primary' : 'danger'}
              onClick={toggleArchive}
              loading={archiveBusy}
              disabled={archiveBusy}
            >
              {isArchived ? (
                <>
                  <ArchiveRestore className="h-4 w-4" /> Restore
                </>
              ) : (
                <>
                  <Archive className="h-4 w-4" /> Archive
                </>
              )}
            </Button>
          </>
        }
      >
        <p className="text-sm text-gray-600">
          {isArchived ? (
            <>
              Restoring <strong>{data.company.name}</strong> will re-enable access for
              all members and unhide the company from the default list view.
            </>
          ) : (
            <>
              Archiving <strong>{data.company.name}</strong> will lock all members out
              and hide the company from the default list view. Accounts, conversations,
              and audit history are preserved. You can restore the company at any time.
            </>
          )}
        </p>
      </Modal>
    </div>
  )
}

// ─── Overview tab ────────────────────────────────────────────────────

function OverviewTab({
  company,
  canSuper,
  onSaved,
}: {
  company: Company
  canSuper: boolean
  onSaved: (c: Company) => void
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [name, setName] = useState(company.name)
  const [slug, setSlug] = useState(company.slug ?? '')
  const [logoUrl, setLogoUrl] = useState(company.logo_url ?? '')
  const [showAdvancedLogo, setShowAdvancedLogo] = useState(false)
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
        <LogoUploader
          companyId={company.id}
          companyName={company.name}
          currentLogoUrl={company.logo_url}
          canSuper={canSuper}
          onChanged={(next) => {
            // Keep the visible URL field in sync so a follow-up "Save"
            // doesn't clobber the uploaded logo with the previous text.
            setLogoUrl(next ?? '')
            router.refresh()
          }}
        />

        <div>
          <button
            type="button"
            onClick={() => setShowAdvancedLogo((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
          >
            {showAdvancedLogo ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Advanced: use external URL
          </button>
          {showAdvancedLogo && (
            <div className="mt-2">
              <Input
                label="Logo URL"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://..."
              />
              <p className="mt-1 text-xs text-gray-500">
                Overrides the uploaded logo on save. Leave blank to use the upload above.
              </p>
            </div>
          )}
        </div>
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
      {canSuper && <DangerZone company={company} />}
    </Card>
  )
}

// ─── Danger zone ─────────────────────────────────────────────────────
// Super-admin-only "Delete company permanently" entry point on the Overview
// tab. Mirrors the confirm-by-typing-name + force-cascade modal pattern
// used on the companies list page so the experience is consistent whether
// you delete from the list or the detail page.

function DangerZone({ company }: { company: Company }) {
  const router = useRouter()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [typedName, setTypedName] = useState('')
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachedCount, setAttachedCount] = useState<number | null>(null)

  const close = useCallback(() => {
    if (busy) return
    setOpen(false)
    setTypedName('')
    setForce(false)
    setError(null)
    setAttachedCount(null)
  }, [busy])

  const handleDelete = useCallback(async () => {
    if (typedName !== company.name) {
      setError(`Type the company name exactly to confirm: "${company.name}"`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const url = `/api/admin/companies/${company.id}?confirm=${encodeURIComponent(company.name)}${force ? '&force=true' : ''}`
      const res = await fetch(url, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // 409 = attached accounts still present. Surface the count and the
        // path forward (detach or force cascade).
        if (res.status === 409 && typeof data?.attached_accounts === 'number') {
          setAttachedCount(data.attached_accounts)
          setError(
            `${data.error} Check "Force delete (cascade)" below to remove them all, or detach accounts on the Accounts tab first.`,
          )
        } else {
          setError(data?.error ?? 'Failed to delete company')
        }
        setBusy(false)
        return
      }
      toast.success(`Company ${company.name} deleted`)
      router.push('/admin/companies')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
      setBusy(false)
    }
  }, [company.id, company.name, typedName, force, router, toast])

  return (
    <>
      <div className="mt-8 border-t border-gray-200 pt-6">
        <h3 className="text-base font-semibold text-red-700">Danger zone</h3>
        <p className="mt-0.5 text-sm text-gray-500">
          Irreversible and destructive actions.
        </p>
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50/40 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <p className="font-medium text-gray-900">Delete this company</p>
              <p className="mt-0.5 text-gray-600">
                Permanently removes the company and (optionally) cascade-deletes
                its accounts, conversations, messages, and users. Cannot be
                undone — consider archiving instead.
              </p>
            </div>
            <Button
              variant="danger"
              onClick={() => setOpen(true)}
              className="shrink-0"
            >
              <Trash2 className="h-4 w-4" /> Delete company permanently
            </Button>
          </div>
        </div>
      </div>

      <Modal
        open={open}
        onClose={close}
        title={`Delete "${company.name}"`}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={busy || typedName !== company.name}
              loading={busy}
            >
              <Trash2 className="h-4 w-4" /> Delete forever
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
            <div className="space-y-1 text-sm text-red-800">
              <p className="font-semibold">This is permanent and cannot be undone.</p>
              <p>
                Deleting this company will cascade-delete all of its accounts,
                conversations, messages, contacts, channel configs, audit
                history, and integration settings.
              </p>
              <p className="mt-2">
                <span className="font-medium">Consider archiving instead</span> —
                it hides the company from active lists but keeps all data so
                you can restore it later.
              </p>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {error}
            </div>
          )}

          <Input
            label={`Type "${company.name}" to confirm`}
            placeholder={company.name}
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            autoFocus
          />

          {(attachedCount ?? 0) > 0 && (
            <label className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 cursor-pointer">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
              />
              <span className="text-sm text-gray-700">
                <span className="font-medium">Force delete (cascade)</span> — also
                remove the {attachedCount} attached account{attachedCount === 1 ? '' : 's'}.
                Without this, you must detach accounts on the Accounts tab first.
              </span>
            </label>
          )}
        </div>
      </Modal>
    </>
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
  const confirm = useConfirm()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachId, setAttachId] = useState('')
  const [attaching, setAttaching] = useState(false)

  const detach = useCallback(
    async (accountId: string) => {
      if (!(await confirm({ message: 'Detach this account from the company?', danger: true }))) return
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
    [companyId, onChanged, toast, confirm],
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
          <Link href={`/admin/accounts?company_id=${companyId}`} className="inline-flex">
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

// ─── Onboarding banner ───────────────────────────────────────────────

function OnboardingBanner({ status }: { status: OnboardingStatus }) {
  return (
    <Card className="border-amber-200 bg-amber-50/60 p-4">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-900">
            Tenant setup checklist
          </p>
          <p className="mt-0.5 text-xs text-amber-800">
            Finish these steps to fully activate this tenant.
          </p>
          <ul className="mt-3 space-y-1.5">
            {status.steps.map((step) => (
              <li key={step.id} className="flex items-center gap-2 text-sm">
                {step.complete ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-gray-400" />
                )}
                <span
                  className={
                    step.complete
                      ? 'text-gray-600 line-through decoration-emerald-600/60'
                      : 'text-gray-800'
                  }
                >
                  {ONBOARDING_LABELS[step.id]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  )
}

// ─── Logo uploader ───────────────────────────────────────────────────

function LogoUploader({
  companyId,
  companyName,
  currentLogoUrl,
  canSuper,
  onChanged,
}: {
  companyId: string
  companyName: string
  currentLogoUrl: string | null
  canSuper: boolean
  onChanged: (nextUrl: string | null) => void
}) {
  const { toast } = useToast()
  const confirm = useConfirm()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState<'upload' | 'delete' | null>(null)

  const handlePick = useCallback(() => {
    inputRef.current?.click()
  }, [])

  const handleFile = useCallback(
    async (file: File) => {
      setBusy('upload')
      try {
        const form = new FormData()
        form.append('file', file)
        const res = await fetch(`/api/admin/companies/${companyId}/logo`, {
          method: 'POST',
          body: form,
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data?.error ?? 'Upload failed')
          return
        }
        toast.success('Logo uploaded')
        onChanged((data as { logo_url?: string | null }).logo_url ?? null)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      } finally {
        setBusy(null)
        // Reset the input so picking the SAME file again re-fires onChange.
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [companyId, onChanged, toast],
  )

  const handleRemove = useCallback(async () => {
    if (!(await confirm({ message: 'Remove the logo for this company?', danger: true }))) return
    setBusy('delete')
    try {
      const res = await fetch(`/api/admin/companies/${companyId}/logo`, {
        method: 'DELETE',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error ?? 'Remove failed')
        return
      }
      toast.success('Logo removed')
      onChanged(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusy(null)
    }
  }, [companyId, onChanged, toast, confirm])

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-4">
      <div className="flex items-start gap-4">
        {currentLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={currentLogoUrl}
            alt={`${companyName} logo`}
            className="h-16 w-16 rounded-md bg-white object-contain ring-1 ring-gray-200"
          />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-md bg-white ring-1 ring-gray-200 text-base font-semibold text-gray-500">
            {companyName.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-800">Company logo</p>
          <p className="mt-0.5 text-xs text-gray-500">
            PNG, JPEG, WebP, or SVG. Max 512 KB.
            {!canSuper && ' Only super-admins can change the logo.'}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handlePick}
              disabled={!canSuper || busy !== null}
            >
              {busy === 'upload' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Uploading…
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" /> {currentLogoUrl ? 'Replace logo' : 'Upload logo'}
                </>
              )}
            </Button>
            {currentLogoUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleRemove}
                disabled={!canSuper || busy !== null}
              >
                {busy === 'delete' ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Removing…
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4" /> Remove
                  </>
                )}
              </Button>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleFile(f)
            }}
          />
        </div>
      </div>
    </div>
  )
}
