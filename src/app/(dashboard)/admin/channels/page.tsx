'use client'

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-client'
import type { Account } from '@/types/database'
import { CHANNEL_KEYS, isChannel } from '@/lib/channels/registry'
import { useUser } from '@/context/user-context'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import {
  Mail,
  MessageSquare,
  Phone,
  MessageCircle,
  Send,
  Facebook,
  Instagram,
  Settings,
  Loader2,
  CheckCircle,
  Trash2,
  X,
  Plus,
  Link as LinkIcon,
  Unlink,
  Copy,
  ChevronDown,
  ChevronRight,
  MoreVertical,
  ShieldCheck,
  KeyRound,
  AlertTriangle,
} from 'lucide-react'
import { CopyField } from '@/components/ui/copy-field'

type Channel = 'email' | 'teams' | 'whatsapp' | 'sms' | 'telegram' | 'messenger' | 'instagram' | 'livechat'

interface ConfigState {
  source: 'db' | 'env' | 'none' | 'db_broken'
  config: Record<string, unknown> | null
  // Persisted Test-Connection result for the account's own (db) credentials.
  lastTestedAt?: string | null
  lastTestOk?: boolean | null
}

const CHANNEL_META: Record<Channel, { label: string; Icon: typeof Mail; color: string }> = {
  email: { label: 'Email (SMTP + IMAP)', Icon: Mail, color: 'text-blue-600' },
  teams: { label: 'Microsoft Teams', Icon: MessageSquare, color: 'text-purple-600' },
  whatsapp: { label: 'WhatsApp', Icon: Phone, color: 'text-green-600' },
  sms: { label: 'SMS (Twilio)', Icon: MessageCircle, color: 'text-pink-600' },
  telegram: { label: 'Telegram', Icon: Send, color: 'text-sky-600' },
  messenger: { label: 'Messenger', Icon: Facebook, color: 'text-blue-500' },
  instagram: { label: 'Instagram', Icon: Instagram, color: 'text-rose-600' },
  livechat: { label: 'Live Chat (website widget)', Icon: MessageSquare, color: 'text-green-600' },
}

// Channel-specific identifier (what uniquely locates this account on the provider side)
const IDENTIFIER_FIELD: Record<Channel, { key: string; label: string; placeholder: string }> = {
  email: { key: 'gmail_address', label: 'Mailbox address', placeholder: 'support@mycompany.com' },
  teams: { key: 'teams_user_id', label: 'Teams user (UPN or object ID)', placeholder: 'support@mycompany.onmicrosoft.com  —or—  GUID' },
  whatsapp: { key: 'whatsapp_phone', label: 'Display phone number (E.164)', placeholder: '+14155552671' },
  // SMS reuses the shared whatsapp_phone E.164 column (accounts are single-channel).
  sms: { key: 'whatsapp_phone', label: 'SMS number (E.164)', placeholder: '+14155552671' },
  // Telegram reuses teams_user_id for the bot handle (accounts are single-channel).
  telegram: { key: 'teams_user_id', label: 'Bot username (@yourbot)', placeholder: '@yourbot' },
  // Messenger reuses teams_user_id for the Page handle.
  messenger: { key: 'teams_user_id', label: 'Facebook Page name or ID', placeholder: 'My Business Page' },
  // Instagram reuses teams_user_id for the IG handle.
  instagram: { key: 'teams_user_id', label: 'Instagram handle (@account)', placeholder: '@youraccount' },
  livechat: { key: 'teams_user_id', label: 'Widget', placeholder: '—' },
}

// Credential fields per channel (what lives in channel_configs, encrypted)
const CRED_FIELDS: Record<
  Channel,
  Array<{ key: string; label: string; type?: 'text' | 'password' | 'number' | 'checkbox'; placeholder?: string; required?: boolean }>
> = {
  email: [
    { key: 'smtp_host', label: 'SMTP Host (outbound)', placeholder: 'smtp.gmail.com', required: true },
    { key: 'smtp_port', label: 'SMTP Port', type: 'number', placeholder: '465', required: true },
    { key: 'smtp_secure', label: 'SMTP use TLS/SSL', type: 'checkbox' },
    { key: 'smtp_user', label: 'SMTP username (auto-fills from mailbox address)', placeholder: 'mailbox@example.com', required: true },
    { key: 'smtp_password', label: 'SMTP password / app password', type: 'password', required: true },
    { key: 'smtp_from_name', label: 'From name', placeholder: 'Unified Comm Portal' },
    { key: 'imap_host', label: 'IMAP Host (leave blank for send-only)', placeholder: 'imap.gmail.com' },
    { key: 'imap_port', label: 'IMAP Port', type: 'number', placeholder: '993' },
    { key: 'imap_secure', label: 'IMAP use TLS/SSL', type: 'checkbox' },
    { key: 'imap_user', label: 'IMAP username (defaults to SMTP)', placeholder: 'mailbox@example.com' },
    { key: 'imap_password', label: 'IMAP password (defaults to SMTP)', type: 'password' },
  ],
  teams: [
    { key: 'azure_tenant_id', label: 'Azure Tenant ID', required: true },
    { key: 'azure_client_id', label: 'Azure Client ID (App Registration)', required: true },
    { key: 'azure_client_secret', label: 'Azure Client Secret', type: 'password', required: true },
  ],
  whatsapp: [
    { key: 'phone_number_id', label: 'Phone Number ID (Meta internal numeric ID, not the phone)', placeholder: '123456789012345', required: true },
    { key: 'access_token', label: 'Access Token (System User token from Meta Business)', type: 'password', required: true },
    { key: 'verify_token', label: 'Webhook Verify Token (you choose this — must match Meta webhook config)', type: 'password' },
    { key: 'app_secret', label: 'Meta App Secret (enables inbound — verifies the webhook signature)', type: 'password' },
    { key: 'graph_version', label: 'Graph API Version', placeholder: 'v21.0' },
  ],
  sms: [
    { key: 'account_sid', label: 'Twilio Account SID', placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', required: true },
    { key: 'auth_token', label: 'Twilio Auth Token', type: 'password', required: true },
    { key: 'from_number', label: 'Twilio sending number (E.164)', placeholder: '+14155552671', required: true },
  ],
  telegram: [
    { key: 'bot_token', label: 'Bot Token (from @BotFather)', type: 'password', required: true },
  ],
  messenger: [
    { key: 'page_id', label: 'Facebook Page ID', required: true },
    { key: 'page_access_token', label: 'Page Access Token (Meta app, pages_messaging)', type: 'password', required: true },
    { key: 'verify_token', label: 'Webhook Verify Token (you choose this — must match Meta webhook config)', type: 'password' },
    { key: 'app_secret', label: 'Meta App Secret (enables inbound — verifies the webhook signature)', type: 'password' },
    { key: 'graph_version', label: 'Graph API Version', placeholder: 'v21.0' },
  ],
  instagram: [
    { key: 'page_id', label: 'Linked Facebook Page ID', required: true },
    { key: 'page_access_token', label: 'Page Access Token (Meta app, instagram_manage_messages)', type: 'password', required: true },
    { key: 'verify_token', label: 'Webhook Verify Token (you choose this — must match Meta webhook config)', type: 'password' },
    { key: 'app_secret', label: 'Meta App Secret (enables inbound — verifies the webhook signature)', type: 'password' },
    { key: 'graph_version', label: 'Graph API Version', placeholder: 'v21.0' },
  ],
  // Live Chat has no provider credentials — it's managed on the dedicated Live
  // Chat admin page, not as an encrypted channel_configs credential set.
  livechat: [],
}

function defaultCreds(channel: Channel): Record<string, unknown> {
  if (channel === 'email') {
    return {
      smtp_host: '', smtp_port: 465, smtp_secure: true, smtp_user: '', smtp_password: '',
      smtp_from_name: 'Unified Comm Portal',
      imap_host: '', imap_port: 993, imap_secure: true, imap_user: '', imap_password: '',
    }
  }
  if (channel === 'teams') {
    return { azure_tenant_id: '', azure_client_id: '', azure_client_secret: '' }
  }
  if (channel === 'sms') {
    return { account_sid: '', auth_token: '', from_number: '' }
  }
  if (channel === 'telegram') {
    return { bot_token: '' }
  }
  if (channel === 'messenger' || channel === 'instagram') {
    return { page_id: '', page_access_token: '', graph_version: 'v21.0' }
  }
  return { phone_number_id: '', access_token: '', verify_token: '', graph_version: 'v21.0' }
}

type ModalMode =
  | { kind: 'create'; channel: Channel }
  | { kind: 'edit'; account: Account; channel: Channel }

export default function ChannelsPage() {
  const supabase = createClient()
  const { toast } = useToast()
  const searchParams = useSearchParams()
  const router = useRouter()
  // Tenant scope from the company switcher. When a tenant is selected
  // (activeCompanyId !== null), restrict accounts to that tenant. When in
  // super_admin combined view (activeCompanyId === null), show every tenant.
  const { activeCompanyId, companyAccountIds } = useUser()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [configs, setConfigs] = useState<Record<string, ConfigState>>({})

  const [modal, setModal] = useState<ModalMode | null>(null)
  const [formName, setFormName] = useState('')
  const [formIdentifier, setFormIdentifier] = useState('')
  const [formCreds, setFormCreds] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  // Feature 1: tenant reuse
  const [reusableTenants, setReusableTenants] = useState<
    Array<{ source_account_id: string; source_account_name: string; tenant_id: string }>
  >([])
  const [reuseSourceId, setReuseSourceId] = useState<string>('')
  // Feature 3: redirect URI copy fields — capture origin client-side for SSR safety
  const [origin, setOrigin] = useState('')
  const [teamsHelpOpen, setTeamsHelpOpen] = useState(false)
  const [emailHelpOpen, setEmailHelpOpen] = useState(false)
  // Row-level overflow menu: tracks which `${account.id}:${channel}` is open, if any.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  // Trigger button ref for the currently-open menu — used to compute the
  // floating menu's position (portal renders to document.body, so we need
  // viewport coordinates from the trigger's bounding rect).
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  // Universal "+ Add Account" picker at the top of the page.
  const [pickerOpen, setPickerOpen] = useState(false)

  // Create-flow: setup method ('oauth' | 'manual'). Only meaningful for
  // email + teams; hidden for whatsapp. Defaults to 'oauth' when the
  // provider is available per the availability endpoint.
  const [setupMode, setSetupMode] = useState<'oauth' | 'manual'>('manual')
  const [oauthAvailability, setOauthAvailability] = useState<{ gmail: boolean; teams: boolean }>({
    gmail: false,
    teams: false,
  })
  const [oauthStarting, setOauthStarting] = useState(false)
  const [tgRegistering, setTgRegistering] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/auth/availability')
      .then((r) => (r.ok ? r.json() : { gmail: false, teams: false }))
      .then((d) => setOauthAvailability({ gmail: Boolean(d.gmail), teams: Boolean(d.teams) }))
      .catch(() => setOauthAvailability({ gmail: false, teams: false }))
  }, [])

  // Close the row overflow menu on any outside mousedown / Escape.
  // The menu itself is portal-rendered with data-menu-portal="<key>" so
  // clicks on menu items don't count as "outside".
  useEffect(() => {
    if (!openMenuId) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      // Allow clicks on the trigger (handled by onClick) and on the portal'd menu.
      if (target.closest?.(`[data-menu-portal="${openMenuId}"]`)) return
      if (target.closest?.(`[data-menu-trigger="${openMenuId}"]`)) return
      setOpenMenuId(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenuId(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenuId])

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
  }, [])

  const loadAccounts = useCallback(async () => {
    setLoading(true)
    let query = supabase
      .from('accounts')
      .select('*')
      .eq('is_active', true)
      .order('name')
    // Multi-tenant scope. When the company switcher has a tenant selected
    // (cookie set), only show that tenant's accounts. Empty companyAccountIds
    // returns no rows, which is the correct answer for a zero-account
    // tenant. activeCompanyId === null is super_admin combined view —
    // leave the query unscoped so every tenant's accounts show.
    if (activeCompanyId) {
      query = query.in('id', companyAccountIds)
    }
    const { data, error } = await query
    if (error) {
      toast.error('Failed to load accounts: ' + error.message)
      setAccounts([])
    } else {
      setAccounts((data as Account[]) || [])
    }
    setLoading(false)
  }, [supabase, toast, activeCompanyId, companyAccountIds])

  const loadConfigStatus = useCallback(async (accountId: string, channel: Channel) => {
    try {
      const res = await fetch(`/api/channels/config?account_id=${accountId}&channel=${channel}`)
      if (!res.ok) return
      const data = await res.json() as ConfigState
      setConfigs((prev) => ({ ...prev, [`${accountId}:${channel}`]: data }))
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadAccounts() }, [loadAccounts])
  useEffect(() => {
    for (const a of accounts) {
      loadConfigStatus(a.id, a.channel_type as Channel)
    }
  }, [accounts, loadConfigStatus])

  // Surface Teams + Gmail OAuth callback results (?teams_oauth=success,
  // ?gmail_oauth=success, ?..._error=...) and strip those params from the
  // URL so a refresh doesn't re-toast.
  useEffect(() => {
    const teamsOk = searchParams.get('teams_oauth')
    const teamsErr = searchParams.get('teams_oauth_error')
    const gmailOk = searchParams.get('gmail_oauth')
    const gmailErr = searchParams.get('gmail_oauth_error')
    if (!teamsOk && !teamsErr && !gmailOk && !gmailErr) return

    const asUser = searchParams.get('as')
    if (teamsOk === 'success') {
      toast.success(asUser ? `Teams connected as ${asUser}` : 'Teams connected')
    } else if (teamsErr) {
      toast.error(`Teams connection failed: ${teamsErr}`)
    }
    if (gmailOk === 'success') {
      toast.success(asUser ? `Gmail connected as ${asUser}` : 'Gmail connected')
    } else if (gmailErr) {
      toast.error(`Gmail connection failed: ${gmailErr}`)
    }
    // Clean the URL
    const params = new URLSearchParams(Array.from(searchParams.entries()))
    params.delete('teams_oauth')
    params.delete('teams_oauth_error')
    params.delete('gmail_oauth')
    params.delete('gmail_oauth_error')
    params.delete('as')
    const qs = params.toString()
    router.replace(qs ? `/admin/channels?${qs}` : '/admin/channels')
  }, [searchParams, router, toast])

  const handleGmailDisconnect = async (account: Account) => {
    if (!confirm(`Disconnect Gmail OAuth for "${account.name}"? The app will revert to SMTP/IMAP password auth — you'll need to re-enter an app password to keep sending/receiving.`)) return
    try {
      const res = await fetch(`/api/auth/gmail/disconnect?account_id=${account.id}`, { method: 'POST' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || 'Disconnect failed')
      }
      toast.success('Gmail OAuth disconnected')
      await loadConfigStatus(account.id, 'email')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const handleTeamsDisconnect = async (account: Account) => {
    if (!confirm(`Disconnect Teams OAuth for "${account.name}"? The app will revert to client-credentials (app permissions) for this account.`)) return
    try {
      const res = await fetch(`/api/auth/teams/disconnect?account_id=${account.id}`, { method: 'POST' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || 'Disconnect failed')
      }
      toast.success('Teams OAuth disconnected')
      await loadConfigStatus(account.id, 'teams')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  // Register the Telegram bot's webhook with Telegram so inbound flows DIRECTLY
  // to /api/webhooks/telegram (no relay). The server generates a per-account
  // secret + calls setWebhook; on success inbound starts immediately.
  const enableTelegramInbound = async (account: Account) => {
    setTgRegistering(account.id)
    try {
      const res = await fetch('/api/channels/telegram/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: account.id }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Failed to enable inbound')
      toast.success('Telegram inbound enabled — messages now flow into your inbox')
      await loadConfigStatus(account.id, 'telegram')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setTgRegistering(null)
    }
  }

  // Copy a Meta channel's per-account inbound webhook URL — paste into Meta's
  // webhook config so inbound flows directly to the app (no relay).
  const copyInboundUrl = (account: Account, ch: Channel) => {
    const u = `${origin}/api/webhooks/${ch}?account=${account.id}`
    navigator.clipboard.writeText(u).then(
      () => toast.success("Inbound webhook URL copied — paste it into your provider's webhook settings"),
      () => toast.error('Could not copy to clipboard'),
    )
  }

  // Secret fields we never pre-fill (the API returns them as •••• masks)
  const SECRET_FIELDS: Record<Channel, string[]> = {
    email: ['smtp_password', 'imap_password'],
    teams: ['azure_client_secret'],
    whatsapp: ['access_token', 'verify_token'],
    sms: ['auth_token'],
    telegram: ['bot_token'],
    messenger: ['page_access_token'],
    instagram: ['page_access_token'],
    livechat: [],
  }

  const openCreate = (channel: Channel) => {
    setModal({ kind: 'create', channel })
    setFormName('')
    setFormIdentifier('')
    setFormCreds(defaultCreds(channel))
    setReuseSourceId('')
    setReusableTenants([])
    // Pick the default setup method. OAuth is preferred when the provider
    // is available on this deployment; fall back to Manual otherwise.
    // WhatsApp always goes Manual (no OAuth path exists).
    if (channel === 'email' && oauthAvailability.gmail) setSetupMode('oauth')
    else if (channel === 'teams' && oauthAvailability.teams) setSetupMode('oauth')
    else setSetupMode('manual')
    if (channel === 'teams') {
      fetch('/api/channels/reusable-tenants?channel=teams')
        .then((r) => (r.ok ? r.json() : { tenants: [] }))
        .then((data) => setReusableTenants(data.tenants || []))
        .catch(() => setReusableTenants([]))
    }
  }

  // Feature 2: duplicate an existing account — opens the create modal
  // pre-filled with non-secret fields from the source config.
  const handleDuplicate = async (account: Account, channel: Channel) => {
    try {
      const res = await fetch(`/api/channels/config?account_id=${account.id}&channel=${channel}`)
      const data = res.ok ? await res.json() : null
      const prefill: Record<string, unknown> = { ...defaultCreds(channel) }
      if (data?.source === 'db' && data.config) {
        // Copy everything except the masked secret fields — let the user re-enter secrets.
        for (const [k, v] of Object.entries(data.config as Record<string, unknown>)) {
          if (SECRET_FIELDS[channel].includes(k)) continue
          prefill[k] = v
        }
      }
      setModal({ kind: 'create', channel })
      setFormName(`${account.name} (copy)`)
      setFormIdentifier('') // force user to enter a new unique identifier
      setFormCreds(prefill)
      setReuseSourceId('')
      // Duplicate implies manual — we're copying saved creds, not doing OAuth.
      setSetupMode('manual')
      if (channel === 'teams') {
        fetch('/api/channels/reusable-tenants?channel=teams')
          .then((r) => (r.ok ? r.json() : { tenants: [] }))
          .then((d) => setReusableTenants(d.tenants || []))
          .catch(() => setReusableTenants([]))
      } else {
        setReusableTenants([])
      }
    } catch (err) {
      toast.error('Duplicate failed: ' + (err as Error).message)
    }
  }

  const openEdit = async (account: Account, channel: Channel) => {
    setModal({ kind: 'edit', account, channel })
    // Edit mode is always "manual" — we're directly editing saved creds.
    setSetupMode('manual')
    // Start with defaults
    let prefill = defaultCreds(channel)
    // Fetch saved config (secrets come back masked); keep non-secret values,
    // blank out secrets so the user re-enters them intentionally.
    try {
      const res = await fetch(`/api/channels/config?account_id=${account.id}&channel=${channel}`)
      if (res.ok) {
        const data = await res.json()
        if (data?.source === 'db' && data.config) {
          const cleaned: Record<string, unknown> = { ...data.config }
          for (const f of SECRET_FIELDS[channel]) {
            cleaned[f] = ''
          }
          prefill = { ...prefill, ...cleaned }
        }
      }
    } catch { /* fall back to defaults on fetch error */ }
    setFormCreds(prefill)
  }

  const closeModal = () => {
    setModal(null)
    setFormName('')
    setFormIdentifier('')
    setFormCreds({})
    setReuseSourceId('')
    setReusableTenants([])
  }

  const handleDeleteAccount = async (account: Account) => {
    if (!confirm(`Delete account "${account.name}" and all its credentials? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/accounts?id=${account.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error || 'Delete failed')
      toast.success('Account deleted')
      await loadAccounts()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const handleDeleteCreds = async (account: Account, channel: Channel) => {
    if (!confirm(`Remove saved credentials for "${account.name}"? Account will fall back to env defaults.`)) return
    try {
      const res = await fetch(`/api/channels/config?account_id=${account.id}&channel=${channel}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      toast.success('Credentials removed')
      await loadConfigStatus(account.id, channel)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const validateCreds = (channel: Channel): string | null => {
    // When reusing a tenant for Teams, the azure_* fields aren't required from the UI —
    // the server copies them from the source account.
    const skipRequired = channel === 'teams' && modal?.kind === 'create' && !!reuseSourceId
    for (const f of CRED_FIELDS[channel]) {
      if (skipRequired) continue
      if (f.required && !formCreds[f.key]) return `${f.label} is required`
    }
    return null
  }

  // OAuth-first create flow: create an account with no identifier/creds,
  // then redirect to the provider's /start endpoint. The callback fills in
  // the identifier (gmail_address or teams_user_id) from the signed-in
  // profile.
  const handleOAuthCreate = async () => {
    if (!modal || modal.kind !== 'create') return
    const channel = modal.channel
    if (channel === 'whatsapp') return
    if (!formName.trim()) return toast.error('Account name is required')

    setOauthStarting(true)
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          channel_type: channel,
          setup_mode: 'oauth',
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Account create failed')
      const accountId: string = json.account.id
      // Hand off to the provider's OAuth start endpoint — it validates
      // admin session, sets the state cookie, and 302s to consent.
      const provider = channel === 'email' ? 'gmail' : 'teams'
      window.location.href = `/api/auth/${provider}/start?account_id=${accountId}`
    } catch (err) {
      toast.error((err as Error).message)
      setOauthStarting(false)
    }
  }

  const handleSave = async () => {
    if (!modal) return
    const channel = modal.channel

    if (modal.kind === 'create') {
      if (!formName.trim()) return toast.error('Account name is required')
      if (!formIdentifier.trim()) return toast.error(IDENTIFIER_FIELD[channel].label + ' is required')
    }
    const credError = validateCreds(channel)
    if (credError) return toast.error(credError)

    setSaving(true)
    try {
      let accountId: string
      const reusingTenant = modal.kind === 'create' && channel === 'teams' && !!reuseSourceId
      if (modal.kind === 'create') {
        const payload: Record<string, unknown> = { name: formName.trim(), channel_type: channel }
        payload[IDENTIFIER_FIELD[channel].key] = formIdentifier.trim()
        // Teams tenant ID comes from the credential (azure_tenant_id) — don't ask twice.
        // When reusing tenant creds the server populates teams_tenant_id from the source config.
        if (channel === 'teams' && !reusingTenant) {
          payload.teams_tenant_id = formCreds.azure_tenant_id
        }
        if (reusingTenant) payload.reuse_tenant_from_account_id = reuseSourceId
        const res = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || 'Account create failed')
        accountId = json.account.id
      } else {
        accountId = modal.account.id
      }

      // When reusing the tenant, the server already saved creds during account create.
      if (!reusingTenant) {
        const credRes = await fetch('/api/channels/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: accountId, channel, config: formCreds }),
        })
        const credJson = await credRes.json()
        if (!credRes.ok) throw new Error(credJson.error || 'Credentials save failed')
      }

      toast.success(modal.kind === 'create' ? 'Account created' : 'Credentials updated')
      closeModal()
      await loadAccounts()
      await loadConfigStatus(accountId, channel)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (!modal) return
    setTesting(true)
    try {
      const res = await fetch('/api/channels/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: modal.channel, config: formCreds }),
      })
      const json = await res.json()
      if (json.ok) toast.success('Connection successful')
      else toast.error('Test failed: ' + (json.error || 'unknown error'))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setTesting(false)
    }
  }

  // Test an account's SAVED credentials (no form config) and persist the
  // result, then refresh the row so the verified / failed badge updates.
  const handleTestSaved = async (account: Account, channel: Channel) => {
    try {
      const res = await fetch('/api/channels/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, account_id: account.id }),
      })
      const json = await res.json()
      if (json.ok) toast.success('Connection verified')
      else toast.error('Test failed: ' + (json.error || 'unknown error'))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      await loadConfigStatus(account.id, channel)
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-96" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
          >
            <div className="flex items-center gap-3 border-b border-gray-100 bg-gradient-to-b from-gray-50/50 to-transparent px-4 py-3">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-5 w-40 rounded" />
              <div className="ml-auto">
                <Skeleton className="h-8 w-28 rounded-lg" />
              </div>
            </div>
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full rounded" />
              <Skeleton className="h-12 w-full rounded" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  const grouped: Record<Channel, Account[]> = { email: [], teams: [], whatsapp: [], sms: [], telegram: [], messenger: [], instagram: [], livechat: [] }
  for (const a of accounts) {
    const ch = a.channel_type as Channel
    if (grouped[ch]) grouped[ch].push(a)
  }

  const currentChannel = modal?.channel
  const identifier = currentChannel ? IDENTIFIER_FIELD[currentChannel] : null

  // Resolve which row the open menu belongs to. `openMenuId` is encoded
  // as "<account_id>:<channel>"; split and look up the account + its
  // config so the portal menu can render the right action set.
  let menuContext:
    | { key: string; account: Account; channel: Channel; state: ConfigState | undefined }
    | null = null
  if (openMenuId) {
    const [accId, ch] = openMenuId.split(':')
    const acc = accounts.find((a) => a.id === accId)
    if (acc && isChannel(ch)) {
      menuContext = { key: openMenuId, account: acc, channel: ch as Channel, state: configs[openMenuId] }
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Channel Configuration</h1>
          <p className="mt-1 text-sm text-slate-600">
            Add accounts per channel and attach their credentials. Secrets are encrypted at rest.
            Accounts without saved credentials fall back to the environment variables from <code className="rounded bg-slate-100 px-1 text-xs">.env.local</code>.
          </p>
        </div>
        <Button
          onClick={() => setPickerOpen(true)}
          className="whitespace-nowrap shadow-sm"
        >
          <Plus className="h-4 w-4" />
          Add Account
        </Button>
      </div>

      {/* Live Chat has no provider credentials — managed on its own admin page. */}
      {(CHANNEL_KEYS.filter((c) => c !== 'livechat') as Channel[]).map((channel) => {
        const meta = CHANNEL_META[channel]
        const list = grouped[channel]
        return (
          <Card key={channel} className="overflow-hidden">
            <div className="flex items-center gap-3 border-b bg-slate-50 px-4 py-3">
              <meta.Icon className={`h-5 w-5 ${meta.color}`} />
              <h2 className="font-semibold">{meta.label}</h2>
              <span className="text-xs text-slate-500">
                {list.length} account{list.length === 1 ? '' : 's'}
              </span>
              <div className="ml-auto">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openCreate(channel)}
                  className="whitespace-nowrap"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add {meta.label.split(' ')[0]} Account
                </Button>
              </div>
            </div>
            {channel === 'teams' && (
              <div className="border-b bg-indigo-50/40 text-xs text-indigo-900">
                <button
                  type="button"
                  onClick={() => setTeamsHelpOpen((v) => !v)}
                  className="flex w-full items-center gap-1 px-4 py-2 text-left font-medium hover:bg-indigo-100/40"
                >
                  {teamsHelpOpen ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  How to set up Microsoft Teams
                </button>
                {teamsHelpOpen && (
                  <div className="space-y-3 px-4 pb-3">
                    <p>
                      Delegated OAuth lets the portal read chat messages as you. Required if your
                      tenant does not have Microsoft&apos;s &quot;Protected API Access&quot; approval
                      for the application-permission flow. In Azure, add delegated Graph permissions:
                      Chat.Read, ChatMessage.Read, User.Read, offline_access.
                    </p>
                    <CopyField
                      label="Teams OAuth redirect URI"
                      value={`${origin}/api/auth/teams/callback`}
                      helpText="Add this to Azure App Registration → Authentication → Web → Redirect URIs"
                    />
                  </div>
                )}
              </div>
            )}
            {channel === 'email' && (
              <div className="border-b bg-sky-50/40 text-xs text-sky-900">
                <button
                  type="button"
                  onClick={() => setEmailHelpOpen((v) => !v)}
                  className="flex w-full items-center gap-1 px-4 py-2 text-left font-medium hover:bg-sky-100/40"
                >
                  {emailHelpOpen ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  How to set up Gmail OAuth
                </button>
                {emailHelpOpen && (
                  <div className="space-y-3 px-4 pb-3">
                    <p>
                      Connect Gmail accounts with one click. In{' '}
                      <a
                        href="https://console.cloud.google.com/apis/credentials"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        Google Cloud Console
                      </a>
                      , create an OAuth 2.0 Client ID (Web app), then save the Client ID and
                      Secret in{' '}
                      <a href="/admin/integrations" className="font-medium underline">
                        Admin &rarr; Integrations
                      </a>
                      . Scopes required: https://mail.google.com/, openid, email, profile.
                    </p>
                    <CopyField
                      label="Gmail OAuth redirect URI"
                      value={`${origin}/api/auth/gmail/callback`}
                      helpText="Add this to Google Cloud Console → Credentials → OAuth client → Authorized redirect URIs"
                    />
                  </div>
                )}
              </div>
            )}
            {list.length === 0 ? (
              <EmptyState
                icon={meta.Icon}
                title={`No ${meta.label.split(' ')[0]} accounts yet`}
                description={`Add a ${meta.label.split(' ')[0].toLowerCase()} account to start ingesting messages from this channel.`}
                action={
                  <Button variant="primary" size="sm" onClick={() => openCreate(channel)}>
                    <Plus className="h-4 w-4" />
                    Add {meta.label.split(' ')[0]} Account
                  </Button>
                }
                className="py-10"
              />
            ) : (
              <div className="divide-y">
                {list.map((account) => {
                  const key = `${account.id}:${channel}`
                  const state = configs[key]
                  const teamsCfg = (channel === 'teams' ? state?.config : null) as
                    | { auth_mode?: string; delegated_user_email?: string }
                    | null
                  const emailCfg = (channel === 'email' ? state?.config : null) as
                    | { auth_mode?: string; google_user_email?: string }
                    | null
                  const isDelegated =
                    channel === 'teams' &&
                    state?.source === 'db' &&
                    teamsCfg?.auth_mode === 'delegated' &&
                    !!teamsCfg?.delegated_user_email
                  const isGmailOAuth =
                    channel === 'email' &&
                    state?.source === 'db' &&
                    emailCfg?.auth_mode === 'gmail_oauth' &&
                    !!emailCfg?.google_user_email
                  const oauthEmail = isDelegated
                    ? teamsCfg?.delegated_user_email
                    : isGmailOAuth
                      ? emailCfg?.google_user_email
                      : null
                  // Status chip text (compact). For OAuth-connected DB rows we append a
                  // suffix so the single chip conveys both storage + auth mode.
                  let statusLabel: string | null = null
                  let statusTone: 'db' | 'env' | 'none' | 'broken' | null = null
                  if (state?.source === 'db') {
                    statusTone = 'db'
                    statusLabel =
                      isDelegated ? 'Your credentials \u00b7 Teams OAuth'
                      : isGmailOAuth ? 'Your credentials \u00b7 Gmail OAuth'
                      : 'Your credentials'
                  } else if (state?.source === 'env') {
                    statusTone = 'env'
                    statusLabel = 'Platform default'
                  } else if (state?.source === 'db_broken') {
                    statusTone = 'broken'
                    statusLabel = 'Credentials error'
                  } else if (state?.source === 'none') {
                    statusTone = 'none'
                    statusLabel = 'Not configured'
                  }
                  // Does the row get an OAuth primary button (shown only when NOT connected)?
                  const showGmailOAuthButton = channel === 'email' && !isGmailOAuth
                  const showTeamsOAuthButton =
                    channel === 'teams' && state?.source === 'db' && !isDelegated
                  const primaryLabel =
                    state?.source === 'db'
                      ? 'Update credentials'
                      : state?.source === 'env'
                        ? 'Use your own credentials'
                        : 'Configure'
                  const menuOpen = openMenuId === key

                  return (
                    <div key={account.id} className="flex items-center justify-between gap-4 px-4 py-3">
                      {/* Left: name + compact chips */}
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate font-medium text-gray-900">{account.name}</span>
                        {statusLabel && (
                          <span
                            className={
                              'inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ' +
                              (statusTone === 'db'
                                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                                : statusTone === 'env'
                                  ? 'bg-blue-50 text-blue-700 ring-blue-200'
                                  : statusTone === 'broken'
                                    ? 'bg-red-50 text-red-700 ring-red-200'
                                    : 'bg-amber-50 text-amber-700 ring-amber-200')
                            }
                          >
                            {statusTone === 'db' && (
                              <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-500" />
                            )}
                            {(isDelegated || isGmailOAuth) && (
                              <ShieldCheck className="h-3 w-3 flex-shrink-0" />
                            )}
                            {statusLabel}
                          </span>
                        )}
                        {/* Test-Connection gate — only for the account's own (db)
                            credentials, and not OAuth-connected configs (their
                            "Connected as …" chip is the verification signal). */}
                        {state?.source === 'db' && !isDelegated && !isGmailOAuth && (
                          <span
                            title={
                              state.lastTestOk === true
                                ? 'Credentials passed the last connection test'
                                : state.lastTestOk === false
                                  ? 'Last connection test failed — open ⋮ → Test connection'
                                  : 'Saved but not yet tested — open ⋮ → Test connection'
                            }
                            className={
                              'inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ' +
                              (state.lastTestOk === true
                                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                                : state.lastTestOk === false
                                  ? 'bg-red-50 text-red-700 ring-red-200'
                                  : 'bg-amber-50 text-amber-700 ring-amber-200')
                            }
                          >
                            {state.lastTestOk === true ? (
                              <CheckCircle className="h-3 w-3 flex-shrink-0" />
                            ) : state.lastTestOk === false ? (
                              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                            ) : (
                              <KeyRound className="h-3 w-3 flex-shrink-0" />
                            )}
                            {state.lastTestOk === true
                              ? 'Verified'
                              : state.lastTestOk === false
                                ? 'Test failed'
                                : 'Not tested'}
                          </span>
                        )}
                        {oauthEmail && (
                          <span
                            title={oauthEmail}
                            className="inline-flex max-w-[240px] flex-shrink items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200"
                          >
                            <LinkIcon className="h-3 w-3 flex-shrink-0" />
                            <span className="truncate">Connected as {oauthEmail}</span>
                          </span>
                        )}
                        {/* Poll-failure warning. Fires at 3 consecutive
                            failures so ops sees trouble before the circuit
                            breaker opens at 5. Hover reveals the truncated
                            last error message. Cap title at 200 chars to
                            keep the native tooltip readable. */}
                        {(account.consecutive_poll_failures ?? 0) >= 3 && (
                          <span
                            title={
                              account.last_poll_error
                                ? `Last error: ${account.last_poll_error.slice(0, 200)}`
                                : 'Polling has failed repeatedly'
                            }
                            className="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 ring-1 ring-red-200"
                          >
                            <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                            {(account.consecutive_poll_failures ?? 0) >= 5
                              ? 'Breaker open'
                              : `${account.consecutive_poll_failures} poll failures`}
                          </span>
                        )}
                      </div>

                      {/* Right: at most 3 visible controls (OAuth connect, Update creds, ⋮).
                          All heights are pinned to h-9 so the row reads as a single
                          horizontal control strip. */}
                      <div className="flex flex-shrink-0 items-center gap-1.5">
                        {showGmailOAuthButton && (
                          <button
                            type="button"
                            onClick={() => {
                              window.location.href = `/api/auth/gmail/start?account_id=${account.id}`
                            }}
                            title="Connect this account to Gmail via Google OAuth (no app password needed)"
                            className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-gray-50"
                          >
                            <svg aria-hidden="true" viewBox="0 0 18 18" className="h-4 w-4">
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
                            Sign in with Google
                          </button>
                        )}
                        {showTeamsOAuthButton && (
                          <button
                            type="button"
                            onClick={() => {
                              window.location.href = `/api/auth/teams/start?account_id=${account.id}`
                            }}
                            title="Connect via delegated OAuth (bypasses Protected API Access)"
                            className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg bg-gray-100 px-3 text-sm font-medium text-gray-700 hover:bg-gray-200"
                          >
                            <LinkIcon className="h-3.5 w-3.5" />
                            Connect Teams
                          </button>
                        )}
                        {channel === 'telegram' && state?.source === 'db' && (
                          <button
                            type="button"
                            onClick={() => enableTelegramInbound(account)}
                            disabled={tgRegistering === account.id}
                            title="Register this bot's webhook with Telegram so inbound messages arrive directly in your inbox — no relay needed"
                            className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg bg-sky-100 px-3 text-sm font-medium text-sky-700 hover:bg-sky-200 disabled:opacity-60"
                          >
                            {tgRegistering === account.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <LinkIcon className="h-3.5 w-3.5" />
                            )}
                            Enable inbound
                          </button>
                        )}
                        {(channel === 'whatsapp' || channel === 'messenger' || channel === 'instagram') && state?.source === 'db' && (
                          <button
                            type="button"
                            onClick={() => copyInboundUrl(account, channel)}
                            title="Copy this account's inbound webhook URL — paste it into Meta's webhook settings to receive messages"
                            className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg bg-gray-100 px-3 text-sm font-medium text-gray-700 hover:bg-gray-200"
                          >
                            <Copy className="h-3.5 w-3.5" />
                            Inbound URL
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openEdit(account, channel)}
                          className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg bg-teal-700 px-3 text-sm font-medium text-white shadow-sm hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2"
                        >
                          <Settings className="h-3.5 w-3.5" />
                          {primaryLabel}
                        </button>
                        {/* Overflow trigger — matches the primary button height.
                            The menu itself is portal-rendered below so it escapes
                            the Card's overflow-hidden clip. */}
                        <button
                          type="button"
                          aria-label="More"
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          data-menu-trigger={key}
                          ref={(el) => {
                            if (menuOpen) menuTriggerRef.current = el
                          }}
                          onClick={() => setOpenMenuId(menuOpen ? null : key)}
                          className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        )
      })}

      {/* Portal-rendered overflow menu. Lives at document.body to escape
          the Card's overflow-hidden clip and to sit above any section
          divider. Position tracks the trigger button via its bounding rect. */}
      {menuContext && (
        <OverflowMenuPortal
          triggerRef={menuTriggerRef}
          menuKey={menuContext.key}
          onClose={() => setOpenMenuId(null)}
        >
          {menuContext.channel !== 'whatsapp' && (
            <button
              type="button"
              onClick={() => {
                setOpenMenuId(null)
                handleDuplicate(menuContext!.account, menuContext!.channel)
              }}
              className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
            >
              <Copy className="h-4 w-4 text-gray-500" />
              Duplicate account
            </button>
          )}
          {menuContext.state?.source === 'db' && (
            <button
              type="button"
              onClick={() => {
                setOpenMenuId(null)
                handleTestSaved(menuContext!.account, menuContext!.channel)
              }}
              className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
            >
              <CheckCircle className="h-4 w-4 text-gray-500" />
              Test connection
            </button>
          )}
          {menuContext.state?.source === 'db' && (
            <button
              type="button"
              onClick={() => {
                setOpenMenuId(null)
                handleDeleteCreds(menuContext!.account, menuContext!.channel)
              }}
              className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
            >
              <Trash2 className="h-4 w-4 text-gray-500" />
              Remove my credentials
            </button>
          )}
          {menuContext.channel === 'email' &&
            menuContext.state?.source === 'db' &&
            (menuContext.state.config as { auth_mode?: string } | null)?.auth_mode === 'gmail_oauth' && (
              <button
                type="button"
                onClick={() => {
                  setOpenMenuId(null)
                  handleGmailDisconnect(menuContext!.account)
                }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
              >
                <Unlink className="h-4 w-4 text-gray-500" />
                Disconnect Gmail OAuth
              </button>
            )}
          {menuContext.channel === 'teams' &&
            menuContext.state?.source === 'db' &&
            (menuContext.state.config as { auth_mode?: string } | null)?.auth_mode === 'delegated' && (
              <button
                type="button"
                onClick={() => {
                  setOpenMenuId(null)
                  handleTeamsDisconnect(menuContext!.account)
                }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
              >
                <Unlink className="h-4 w-4 text-gray-500" />
                Disconnect Teams OAuth
              </button>
            )}
          <div className="my-1 border-t border-gray-100" />
          <button
            type="button"
            onClick={() => {
              setOpenMenuId(null)
              handleDeleteAccount(menuContext!.account)
            }}
            className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
          >
            <Trash2 className="h-4 w-4" />
            Delete account
          </button>
        </OverflowMenuPortal>
      )}

      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-black/5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-100 bg-gradient-to-b from-gray-50/50 to-transparent px-5 py-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  New account
                </p>
                <h3 className="text-base font-semibold text-gray-900">Pick a channel</h3>
              </div>
              <button
                onClick={() => setPickerOpen(false)}
                className="text-slate-400 hover:text-slate-600"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid gap-3 p-5 sm:grid-cols-3">
              {(CHANNEL_KEYS.filter((c) => c !== 'livechat') as Channel[]).map((ch) => {
                const m = CHANNEL_META[ch]
                const n = grouped[ch].length
                // Match the palette tone to each channel's icon color.
                const chipTone =
                  ch === 'email'
                    ? 'bg-blue-50 text-blue-700 ring-blue-200'
                    : ch === 'teams'
                      ? 'bg-violet-50 text-violet-700 ring-violet-200'
                      : 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                return (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => {
                      setPickerOpen(false)
                      openCreate(ch)
                    }}
                    className="flex cursor-pointer flex-col items-start gap-3 rounded-xl border border-gray-200/80 p-5 text-left transition hover:border-gray-300 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-200"
                  >
                    <div
                      className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 ${chipTone}`}
                    >
                      <m.Icon className="h-5 w-5" strokeWidth={2} />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-gray-900">
                        {m.label.split(' ')[0]}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {n} account{n === 1 ? '' : 's'}
                      </p>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {modal && currentChannel && identifier && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white shadow-xl">
            <div className="sticky top-0 flex items-center justify-between border-b bg-white px-5 py-3">
              <h3 className="font-semibold">
                {modal.kind === 'create'
                  ? `New ${CHANNEL_META[currentChannel].label} Account`
                  : `${CHANNEL_META[currentChannel].label} — ${modal.account.name}`}
              </h3>
              <button onClick={closeModal} className="text-slate-400 hover:text-slate-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              {/* Setup method picker (create flow, email + teams only). WhatsApp
                  has no OAuth path so it always goes Manual. */}
              {modal.kind === 'create' && currentChannel !== 'whatsapp' && (
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Setup method
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {(() => {
                      const oauthOk =
                        (currentChannel === 'email' && oauthAvailability.gmail) ||
                        (currentChannel === 'teams' && oauthAvailability.teams)
                      const providerLabel =
                        currentChannel === 'email' ? 'Google' : 'Microsoft'
                      return (
                        <>
                          <button
                            type="button"
                            disabled={!oauthOk}
                            onClick={() => oauthOk && setSetupMode('oauth')}
                            title={
                              oauthOk
                                ? `Sign in with ${providerLabel} — no passwords needed`
                                : currentChannel === 'teams'
                                  ? 'OAuth not available: configure Azure creds at /admin/integrations (or set AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET env vars), or use Manual setup first and connect OAuth per-account.'
                                  : 'OAuth not available: configure Google creds at /admin/integrations (or set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET env vars).'
                            }
                            className={
                              'flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition ' +
                              (!oauthOk
                                ? 'cursor-not-allowed border-gray-200 bg-gray-50 opacity-60'
                                : setupMode === 'oauth'
                                  ? 'border-teal-600 bg-teal-50/50 ring-2 ring-teal-200'
                                  : 'border-gray-200 hover:border-gray-300')
                            }
                          >
                            <div className="flex items-center gap-2">
                              <ShieldCheck className="h-4 w-4 text-teal-700" />
                              <span className="text-sm font-semibold text-gray-900">
                                Sign in with {providerLabel}
                              </span>
                            </div>
                            <p className="text-xs text-gray-500">
                              {oauthOk
                                ? 'Recommended — one-click setup, no passwords'
                                : 'Unavailable on this deployment'}
                            </p>
                            {!oauthOk && (
                              <a
                                href="/admin/integrations"
                                onClick={(e) => e.stopPropagation()}
                                className="text-xs font-medium text-teal-700 hover:underline"
                              >
                                Configure OAuth app in Integrations &rarr;
                              </a>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => setSetupMode('manual')}
                            className={
                              'flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition ' +
                              (setupMode === 'manual'
                                ? 'border-teal-600 bg-teal-50/50 ring-2 ring-teal-200'
                                : 'border-gray-200 hover:border-gray-300')
                            }
                          >
                            <div className="flex items-center gap-2">
                              <KeyRound className="h-4 w-4 text-gray-600" />
                              <span className="text-sm font-semibold text-gray-900">
                                Manual setup
                              </span>
                            </div>
                            <p className="text-xs text-gray-500">
                              {currentChannel === 'email'
                                ? 'Use SMTP / IMAP credentials'
                                : 'Use Azure app registration'}
                            </p>
                          </button>
                        </>
                      )
                    })()}
                  </div>
                </div>
              )}

              {/* OAuth create branch — only name + big primary button. */}
              {modal.kind === 'create' && setupMode === 'oauth' && currentChannel !== 'whatsapp' && (
                <div className="space-y-3 rounded border border-slate-200 p-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-700">Account name</label>
                    <Input
                      value={formName}
                      placeholder="e.g. Support, Sales, MyCompany-IT"
                      onChange={(e) => setFormName(e.target.value)}
                      className="mt-1"
                    />
                  </div>
                  <p className="rounded bg-sky-50 px-3 py-2 text-xs text-sky-800">
                    Clicking the button below creates the account and redirects you to{' '}
                    {currentChannel === 'email' ? 'Google' : 'Microsoft'} to grant access.
                    The connected email address will be filled in automatically from your
                    sign-in profile.
                  </p>
                  <button
                    type="button"
                    disabled={oauthStarting || !formName.trim()}
                    onClick={handleOAuthCreate}
                    className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 text-sm font-medium text-white shadow-sm hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-teal-400"
                  >
                    {oauthStarting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : currentChannel === 'email' ? (
                      <svg aria-hidden="true" viewBox="0 0 18 18" className="h-4 w-4">
                        <path fill="#fff" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
                      </svg>
                    ) : (
                      <LinkIcon className="h-4 w-4" />
                    )}
                    {currentChannel === 'email'
                      ? 'Sign in with Google'
                      : 'Connect Microsoft Teams'}
                  </button>
                </div>
              )}

              {/* Manual create branch — the original identifier + creds form. */}
              {modal.kind === 'create' && (setupMode === 'manual' || currentChannel === 'whatsapp') && (
                <div className="space-y-3 rounded border border-slate-200 p-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-700">Account name</label>
                    <Input
                      value={formName}
                      placeholder="e.g. Support, Sales, MyCompany-IT"
                      onChange={(e) => setFormName(e.target.value)}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700">{identifier.label}</label>
                    <Input
                      value={formIdentifier}
                      placeholder={identifier.placeholder}
                      onChange={(e) => {
                        const val = e.target.value
                        setFormIdentifier(val)
                        // For email accounts, auto-fill SMTP/IMAP usernames from the mailbox address
                        // (only when empty or still matching the previous mailbox — don't clobber manual edits).
                        if (currentChannel === 'email') {
                          setFormCreds((prev) => {
                            const next = { ...prev }
                            if (!prev.smtp_user || prev.smtp_user === formIdentifier) next.smtp_user = val
                            if (!prev.imap_user || prev.imap_user === formIdentifier) next.imap_user = val
                            return next
                          })
                        }
                      }}
                      className="mt-1"
                    />
                  </div>
                  {/* Feature 1: reuse Azure tenant creds when adding Teams accounts in the same tenant. */}
                  {currentChannel === 'teams' && reusableTenants.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-slate-700">
                        Reuse Azure setup
                      </label>
                      <select
                        value={reuseSourceId}
                        onChange={(e) => setReuseSourceId(e.target.value)}
                        className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                      >
                        <option value="">— Enter new tenant credentials below —</option>
                        {reusableTenants.map((t) => (
                          <option key={t.source_account_id} value={t.source_account_id}>
                            {t.source_account_name} (tenant …{t.tenant_id.slice(-8)})
                          </option>
                        ))}
                      </select>
                      {reuseSourceId && (
                        <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200">
                          <CheckCircle className="h-3 w-3" />
                          Using saved tenant credentials
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Credential form: shown in Edit mode always, and in Create mode
                  only when Manual setup is picked (or always for whatsapp). */}
              {(modal.kind === 'edit' || setupMode === 'manual' || currentChannel === 'whatsapp') && (
                <>
                  <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {modal.kind === 'edit'
                      ? 'Non-secret fields are pre-filled from your saved config. Passwords and tokens are hidden for security — re-enter them to save.'
                      : 'Secrets are encrypted at rest. Fill all required fields before saving.'}
                  </p>
                  {CRED_FIELDS[currentChannel].map((f) => {
                    // When reusing tenant creds on a new Teams account, hide the azure_* fields
                    // — the server copies them from the source account.
                    const reusingTenant =
                      modal.kind === 'create' &&
                      currentChannel === 'teams' &&
                      !!reuseSourceId &&
                      f.key.startsWith('azure_')
                    if (reusingTenant) return null
                    return (
                      <div key={f.key}>
                        <label className="block text-sm font-medium text-slate-700">{f.label}</label>
                        {f.type === 'checkbox' ? (
                          <input
                            type="checkbox"
                            checked={Boolean(formCreds[f.key])}
                            onChange={(e) => setFormCreds((v) => ({ ...v, [f.key]: e.target.checked }))}
                            className="mt-1 h-4 w-4"
                          />
                        ) : (
                          <Input
                            type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                            value={String(formCreds[f.key] ?? '')}
                            placeholder={f.placeholder}
                            onChange={(e) =>
                              setFormCreds((v) => ({
                                ...v,
                                [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value,
                              }))
                            }
                            className="mt-1"
                          />
                        )}
                      </div>
                    )
                  })}
                </>
              )}
            </div>
            {/* Hide the manual Save/Test footer when we're in OAuth create
                mode — that flow has its own in-body primary button. */}
            {!(modal.kind === 'create' && setupMode === 'oauth' && currentChannel !== 'whatsapp') && (
              <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t bg-slate-50 px-5 py-3">
                <Button variant="secondary" onClick={handleTest} disabled={testing || saving}>
                  {testing && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  Test connection
                </Button>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={closeModal} disabled={saving}>
                    Cancel
                  </Button>
                  <Button onClick={handleSave} disabled={saving || testing}>
                    {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                    {modal.kind === 'create' ? 'Create account' : 'Save credentials'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Overflow menu rendered through a React portal ────────────────────
// The Card wrapping each channel section uses `overflow-hidden` so that
// the rounded corners and divide-y line up, which clips any absolutely-
// positioned popover rendered inside it. Rendering the menu into
// document.body sidesteps the clip. We compute its position from the
// trigger button's bounding rect (position:fixed, right-aligned, 4px
// below the button) and keep it in sync on scroll + resize.
interface OverflowMenuPortalProps {
  triggerRef: React.RefObject<HTMLButtonElement | null>
  menuKey: string
  onClose: () => void
  children: React.ReactNode
}

function OverflowMenuPortal({
  triggerRef,
  menuKey,
  onClose,
  children,
}: OverflowMenuPortalProps) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  // Compute initial position synchronously so the menu appears in the
  // right spot on first paint (no flicker from (0,0) → correct coords).
  useLayoutEffect(() => {
    const compute = () => {
      const btn = triggerRef.current
      if (!btn) return
      const rect = btn.getBoundingClientRect()
      setPos({
        top: rect.bottom + 4,
        // Right-align to the trigger: distance from viewport right edge to trigger's right.
        right: Math.max(0, window.innerWidth - rect.right),
      })
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [triggerRef, menuKey])

  // SSR safety — document is not defined during server render.
  if (typeof document === 'undefined') return null
  if (!pos) return null

  const node = (
    <div
      data-menu-portal={menuKey}
      role="menu"
      // Each menu item already calls setOpenMenuId(null) before running its
      // action, but we also close on ANY bubbled click inside the menu so
      // unhandled clicks on dividers / padding don't leave the menu stuck open.
      onClick={onClose}
      style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 60 }}
      className="w-56 overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-lg ring-1 ring-black/5"
    >
      {children}
    </div>
  )
  return createPortal(node, document.body)
}
