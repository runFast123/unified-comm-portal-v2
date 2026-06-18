'use client'

/**
 * Admin → Integrations
 *
 * DB-backed OAuth app credentials (Google Cloud OAuth client, Azure App
 * Registration). Each company configures its OWN OAuth client now — see
 * migration 20260528170000_integrations_per_company.sql. The API
 * automatically scopes to the caller's active company (super_admin via
 * the switcher cookie, company_admin via their own home company).
 *
 * Admin gating is enforced server-side by `./layout.tsx`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { CopyField } from '@/components/ui/copy-field'
import { useToast } from '@/components/ui/toast'
import { timeAgo } from '@/lib/utils'

type IntegrationKey = 'google_oauth' | 'azure_oauth'

interface IntegrationStatus {
  source: 'db' | 'env' | 'none'
  last_tested_at: string | null
  last_tested_ok: boolean | null
  client_id_last4: string | null
}

interface StatusMap {
  google_oauth: IntegrationStatus
  azure_oauth: IntegrationStatus
  company_id: string | null
}

const EMPTY_STATUS: IntegrationStatus = {
  source: 'none',
  last_tested_at: null,
  last_tested_ok: null,
  client_id_last4: null,
}

interface IntegrationsClientProps {
  /** Server-resolved active company id (super_admin via cookie, company_admin home). */
  activeCompanyId: string | null
  /** Display name of the active company — rendered in the scope banner. */
  activeCompanyName: string | null
  /** true when the caller is a super_admin (can switch tenants via the header switcher). */
  canSwitchCompany: boolean
}

export default function IntegrationsClient({
  activeCompanyId,
  activeCompanyName,
  canSwitchCompany,
}: IntegrationsClientProps) {
  const { toast } = useToast()
  const [statuses, setStatuses] = useState<StatusMap | null>(null)
  const [loading, setLoading] = useState(true)
  const [origin, setOrigin] = useState('')

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/integrations', { cache: 'no-store' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `Failed to load (${res.status})`)
      }
      setStatuses((await res.json()) as StatusMap)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load integrations')
      setStatuses({ google_oauth: EMPTY_STATUS, azure_oauth: EMPTY_STATUS, company_id: activeCompanyId })
    } finally {
      setLoading(false)
    }
  }, [toast, activeCompanyId])

  useEffect(() => {
    load()
  }, [load])

  // If the API echoed a different company_id than the one server-resolved on
  // page load, the user switched companies in the header — reload so the
  // scope banner shows the new company's name (we resolve that server-side).
  // Without this the banner would say "Company A" while the statuses below
  // describe Company B.
  useEffect(() => {
    if (statuses && statuses.company_id && statuses.company_id !== activeCompanyId) {
      if (typeof window !== 'undefined') window.location.reload()
    }
  }, [statuses, activeCompanyId])

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Integrations</h1>
        <p className="mt-1 text-sm text-gray-500">
          Configure the OAuth apps used by the portal. These control the &ldquo;Sign in with Google&rdquo; and
          &ldquo;Connect Microsoft&rdquo; flows on the{' '}
          <Link href="/admin/channels" className="font-medium text-teal-700 hover:underline">
            Channels
          </Link>{' '}
          page. Values saved here take precedence over any matching env vars.
        </p>
      </div>

      {/* Active-company banner — makes it obvious which tenant's creds we're editing. */}
      <div className="flex items-start gap-3 rounded-xl border border-blue-200/80 bg-blue-50/60 px-4 py-3 text-sm text-blue-900">
        <Building2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            Editing for company:{' '}
            <span className="font-semibold">{activeCompanyName ?? 'Unknown'}</span>
          </p>
          <p className="mt-0.5 text-xs text-blue-800/80">
            Each company has its own Google &amp; Microsoft OAuth client. Saving here only changes credentials for{' '}
            <strong>{activeCompanyName ?? 'this tenant'}</strong> &mdash; other tenants are unaffected.
            {canSwitchCompany && ' Use the company switcher in the header to manage a different tenant.'}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
          <span className="ml-3 text-gray-500">Loading integrations&hellip;</span>
        </div>
      ) : (
        <div className="space-y-5">
          <GoogleIntegrationCard
            status={statuses?.google_oauth ?? EMPTY_STATUS}
            origin={origin}
            onChanged={load}
          />
          <AzureIntegrationCard
            status={statuses?.azure_oauth ?? EMPTY_STATUS}
            origin={origin}
            onChanged={load}
          />
        </div>
      )}
    </div>
  )
}

// ─── Shared primitives ───────────────────────────────────────────────

function SourceChip({ source }: { source: IntegrationStatus['source'] }) {
  if (source === 'db') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Configured in portal
      </span>
    )
  }
  if (source === 'env') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700 ring-1 ring-gray-200">
        Using env defaults
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">
      <TriangleAlert className="h-3 w-3" />
      Not configured
    </span>
  )
}

function TestedPill({ status }: { status: IntegrationStatus }) {
  if (status.source !== 'db') return null
  if (status.last_tested_ok === true) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">
        <CheckCircle2 className="h-3 w-3" />
        Tested OK {status.last_tested_at ? timeAgo(status.last_tested_at) : ''}
      </span>
    )
  }
  if (status.last_tested_ok === false) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 ring-1 ring-red-200">
        <XCircle className="h-3 w-3" />
        Last test failed
      </span>
    )
  }
  return null
}

interface IntegrationCardShellProps {
  iconBg: string
  iconRing: string
  icon: React.ReactNode
  title: string
  subtitle: string
  status: IntegrationStatus
  children: React.ReactNode
}

function IntegrationCardShell({
  iconBg,
  iconRing,
  icon,
  title,
  subtitle,
  status,
  children,
}: IntegrationCardShellProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
      <div className="flex items-start gap-4 border-b border-gray-100 bg-gradient-to-b from-gray-50/50 to-transparent px-5 py-4">
        <div
          className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ring-1 ${iconBg} ${iconRing}`}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900">{title}</h2>
            <SourceChip source={status.source} />
            <TestedPill status={status} />
          </div>
          <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>
          {status.client_id_last4 && (
            <p className="mt-1 text-xs text-gray-500">
              Client ID ending in{' '}
              <span className="font-mono tabular-nums text-gray-700">
                &hellip;{status.client_id_last4}
              </span>
            </p>
          )}
        </div>
      </div>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </div>
  )
}

// ─── Google (Gmail OAuth) card ───────────────────────────────────────

function GoogleIntegrationCard({
  status,
  origin,
  onChanged,
}: {
  status: IntegrationStatus
  origin: string
  onChanged: () => void | Promise<void>
}) {
  const { toast } = useToast()
  const confirm = useConfirm()
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testingSaved, setTestingSaved] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [formOpen, setFormOpen] = useState(status.source !== 'db')
  const [instructionsOpen, setInstructionsOpen] = useState(false)

  // Keep the form collapsed by default when creds are already saved.
  useEffect(() => {
    setFormOpen(status.source !== 'db')
  }, [status.source])

  const redirectUri = useMemo(
    () => (origin ? `${origin}/api/auth/gmail/callback` : ''),
    [origin]
  )

  const canSubmit = clientId.trim().length > 0 && clientSecret.trim().length > 0

  const handleSave = async () => {
    if (!canSubmit) return
    setSaving(true)
    try {
      const res = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'google_oauth',
          config: {
            client_id: clientId.trim(),
            client_secret: clientSecret.trim(),
          },
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Save failed')
      toast.success('Google OAuth credentials saved')
      setClientId('')
      setClientSecret('')
      setFormOpen(false)
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleTestInline = async () => {
    if (!canSubmit) return
    setTesting(true)
    try {
      const res = await fetch('/api/integrations/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'google_oauth',
          config: {
            client_id: clientId.trim(),
            client_secret: clientSecret.trim(),
          },
        }),
      })
      const j = (await res.json()) as { ok?: boolean; error?: string }
      if (j.ok) toast.success('Credentials look valid')
      else toast.error(j.error || 'Test failed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  const handleTestSaved = async () => {
    setTestingSaved(true)
    try {
      const res = await fetch('/api/integrations/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'google_oauth' }),
      })
      const j = (await res.json()) as { ok?: boolean; error?: string }
      if (j.ok) toast.success('Saved credentials verified')
      else toast.error(j.error || 'Test failed')
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed')
    } finally {
      setTestingSaved(false)
    }
  }

  const handleRemove = async () => {
    if (!(await confirm({ message: 'Remove saved Google OAuth credentials? The portal will fall back to env vars (if set).', danger: true }))) {
      return
    }
    setRemoving(true)
    try {
      const res = await fetch('/api/integrations?key=google_oauth', { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Remove failed')
      toast.success('Removed. Falling back to env defaults (if any).')
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Remove failed')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <IntegrationCardShell
      iconBg="bg-blue-50"
      iconRing="ring-blue-200"
      icon={<GoogleLogo className="h-5 w-5" />}
      title="Google (Gmail OAuth)"
      subtitle="Used by the 'Sign in with Google' flow when adding Gmail accounts."
      status={status}
    >
      <SetupInstructions
        open={instructionsOpen}
        onToggle={() => setInstructionsOpen((v) => !v)}
        title="How to create the Google OAuth client"
      >
        <ol className="list-decimal space-y-2 pl-4">
          <li>
            Open{' '}
            <a
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-teal-700 hover:underline"
            >
              Google Cloud Console &rarr; APIs &amp; Services &rarr; Credentials
            </a>
            .
          </li>
          <li>
            Click <strong>Create credentials</strong> &rarr; <strong>OAuth client ID</strong> &rarr;{' '}
            <strong>Web application</strong>.
          </li>
          <li>
            Under <strong>Authorized redirect URIs</strong>, add the URI below.
          </li>
          <li>
            Enable the Gmail API under{' '}
            <a
              href="https://console.cloud.google.com/apis/library/gmail.googleapis.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-teal-700 hover:underline"
            >
              APIs &amp; Services &rarr; Library
            </a>
            .
          </li>
          <li>
            Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> and paste them below.
          </li>
        </ol>
        <div className="mt-3">
          <CopyField
            label="Authorized redirect URI"
            value={redirectUri || 'Loading origin…'}
            helpText="Paste this into Google Cloud Console exactly — including the scheme and path."
          />
        </div>
      </SetupInstructions>

      {status.source === 'db' && !formOpen ? (
        <div className="flex flex-col gap-3 rounded-xl border border-gray-200/80 bg-gray-50/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">Credentials are saved in the portal.</p>
            <p className="mt-0.5 text-xs text-gray-500">
              Client Secret is encrypted at rest and never displayed. Click Update to replace it.
            </p>
          </div>
          <div className="flex flex-shrink-0 flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleTestSaved}
              loading={testingSaved}
              disabled={testingSaved}
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Test saved creds
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setFormOpen(true)}>
              Update
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleRemove}
              loading={removing}
              disabled={removing}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 rounded-xl border border-gray-200/80 bg-white p-4">
          {status.source === 'env' && (
            <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
              <ShieldAlert className="mt-0.5 h-4 w-4 text-gray-500" />
              <span>
                Currently using env vars <code>GOOGLE_OAUTH_CLIENT_ID</code> /{' '}
                <code>GOOGLE_OAUTH_CLIENT_SECRET</code>. Saving below will override them.
              </span>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700">Client ID</label>
            <Input
              className="mt-1"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="123456789-abcdef.apps.googleusercontent.com"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Client Secret</label>
            <Input
              className="mt-1"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={status.source === 'db' ? 'Enter a new secret to replace the saved one' : 'GOCSPX-…'}
              autoComplete="new-password"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleTestInline}
                loading={testing}
                disabled={!canSubmit || testing}
              >
                Test
              </Button>
              {status.source === 'db' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setClientId('')
                    setClientSecret('')
                    setFormOpen(false)
                  }}
                  disabled={saving}
                >
                  Cancel
                </Button>
              )}
            </div>
            <Button onClick={handleSave} loading={saving} disabled={!canSubmit || saving}>
              Save
            </Button>
          </div>
        </div>
      )}
    </IntegrationCardShell>
  )
}

// ─── Azure (Teams OAuth) card ────────────────────────────────────────

function AzureIntegrationCard({
  status,
  origin,
  onChanged,
}: {
  status: IntegrationStatus
  origin: string
  onChanged: () => void | Promise<void>
}) {
  const { toast } = useToast()
  const confirm = useConfirm()
  const [tenantId, setTenantId] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testingSaved, setTestingSaved] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [formOpen, setFormOpen] = useState(status.source !== 'db')
  const [instructionsOpen, setInstructionsOpen] = useState(false)

  useEffect(() => {
    setFormOpen(status.source !== 'db')
  }, [status.source])

  const redirectUri = useMemo(
    () => (origin ? `${origin}/api/auth/teams/callback` : ''),
    [origin]
  )

  const canSubmit =
    tenantId.trim().length > 0 &&
    clientId.trim().length > 0 &&
    clientSecret.trim().length > 0

  const handleSave = async () => {
    if (!canSubmit) return
    setSaving(true)
    try {
      const res = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'azure_oauth',
          config: {
            tenant_id: tenantId.trim(),
            client_id: clientId.trim(),
            client_secret: clientSecret.trim(),
          },
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Save failed')
      toast.success('Azure OAuth credentials saved')
      setTenantId('')
      setClientId('')
      setClientSecret('')
      setFormOpen(false)
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleTestInline = async () => {
    if (!canSubmit) return
    setTesting(true)
    try {
      const res = await fetch('/api/integrations/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'azure_oauth',
          config: {
            tenant_id: tenantId.trim(),
            client_id: clientId.trim(),
            client_secret: clientSecret.trim(),
          },
        }),
      })
      const j = (await res.json()) as { ok?: boolean; error?: string }
      if (j.ok) toast.success('Credentials look valid')
      else toast.error(j.error || 'Test failed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  const handleTestSaved = async () => {
    setTestingSaved(true)
    try {
      const res = await fetch('/api/integrations/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'azure_oauth' }),
      })
      const j = (await res.json()) as { ok?: boolean; error?: string }
      if (j.ok) toast.success('Saved credentials verified')
      else toast.error(j.error || 'Test failed')
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed')
    } finally {
      setTestingSaved(false)
    }
  }

  const handleRemove = async () => {
    if (!(await confirm({ message: 'Remove saved Azure OAuth credentials? The portal will fall back to env vars (if set).', danger: true }))) {
      return
    }
    setRemoving(true)
    try {
      const res = await fetch('/api/integrations?key=azure_oauth', { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Remove failed')
      toast.success('Removed. Falling back to env defaults (if any).')
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Remove failed')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <IntegrationCardShell
      iconBg="bg-violet-50"
      iconRing="ring-violet-200"
      icon={<MicrosoftLogo className="h-5 w-5" />}
      title="Microsoft (Teams OAuth)"
      subtitle="Used by the 'Connect Teams' flow for delegated + shared-app authentication."
      status={status}
    >
      <SetupInstructions
        open={instructionsOpen}
        onToggle={() => setInstructionsOpen((v) => !v)}
        title="How to create the Azure App Registration"
      >
        <ol className="list-decimal space-y-2 pl-4">
          <li>
            Open{' '}
            <a
              href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-teal-700 hover:underline"
            >
              Azure Portal &rarr; App registrations
            </a>{' '}
            and click <strong>New registration</strong>.
          </li>
          <li>
            Under <strong>Authentication</strong>, add a <strong>Web</strong> platform with the redirect URI below.
          </li>
          <li>
            Under <strong>API permissions</strong>, add delegated Graph permissions: <code>Chat.Read</code>,{' '}
            <code>ChatMessage.Read</code>, <code>User.Read</code>, <code>offline_access</code>.
          </li>
          <li>
            Under <strong>Certificates &amp; secrets</strong>, create a new <strong>Client secret</strong> and
            copy its <em>value</em> (not the ID).
          </li>
          <li>
            From the app overview, copy the <strong>Directory (tenant) ID</strong> and{' '}
            <strong>Application (client) ID</strong>.
          </li>
        </ol>
        <div className="mt-3">
          <CopyField
            label="Authentication redirect URI"
            value={redirectUri || 'Loading origin…'}
            helpText="Add this under App registration &rarr; Authentication &rarr; Web &rarr; Redirect URIs."
          />
        </div>
      </SetupInstructions>

      {status.source === 'db' && !formOpen ? (
        <div className="flex flex-col gap-3 rounded-xl border border-gray-200/80 bg-gray-50/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">Credentials are saved in the portal.</p>
            <p className="mt-0.5 text-xs text-gray-500">
              Client Secret is encrypted at rest and never displayed. Click Update to replace it.
            </p>
          </div>
          <div className="flex flex-shrink-0 flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleTestSaved}
              loading={testingSaved}
              disabled={testingSaved}
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Test saved creds
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setFormOpen(true)}>
              Update
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleRemove}
              loading={removing}
              disabled={removing}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 rounded-xl border border-gray-200/80 bg-white p-4">
          {status.source === 'env' && (
            <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
              <ShieldAlert className="mt-0.5 h-4 w-4 text-gray-500" />
              <span>
                Currently using env vars <code>AZURE_TENANT_ID</code> / <code>AZURE_CLIENT_ID</code> /{' '}
                <code>AZURE_CLIENT_SECRET</code>. Saving below will override them.
              </span>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700">Tenant ID</label>
            <Input
              className="mt-1"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Client ID</label>
            <Input
              className="mt-1"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Client Secret (value)</label>
            <Input
              className="mt-1"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={status.source === 'db' ? 'Enter a new secret to replace the saved one' : 'Paste the secret value (not the ID)'}
              autoComplete="new-password"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleTestInline}
                loading={testing}
                disabled={!canSubmit || testing}
              >
                Test
              </Button>
              {status.source === 'db' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setTenantId('')
                    setClientId('')
                    setClientSecret('')
                    setFormOpen(false)
                  }}
                  disabled={saving}
                >
                  Cancel
                </Button>
              )}
            </div>
            <Button onClick={handleSave} loading={saving} disabled={!canSubmit || saving}>
              Save
            </Button>
          </div>
        </div>
      )}
    </IntegrationCardShell>
  )
}

// ─── Collapsible instructions ────────────────────────────────────────

function SetupInstructions({
  open,
  onToggle,
  title,
  children,
}: {
  open: boolean
  onToggle: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200/80 bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <KeyRound className="h-3.5 w-3.5 text-gray-500" />
        {title}
      </button>
      {open && (
        <div className="space-y-2 border-t border-gray-100 bg-gray-50/40 px-4 py-3 text-xs text-gray-700">
          {children}
        </div>
      )}
    </div>
  )
}

// ─── Vendor logos (inline SVG — no extra deps) ───────────────────────

function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18" className={className}>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.706A5.41 5.41 0 013.68 9c0-.593.102-1.17.284-1.706V4.962H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z"
      />
    </svg>
  )
}

function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 21 21" className={className}>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  )
}
