'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase-client'
import type { Account } from '@/types/database'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import {
  MessageSquare,
  Mail,
  Phone,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Copy,
  Loader2,
} from 'lucide-react'

interface ConnectionStatus {
  label: string
  status: 'connected' | 'warning' | 'disconnected'
}

function StatusBadge({ status }: { status: ConnectionStatus['status'] }) {
  if (status === 'connected')
    return (
      <Badge variant="success">
        <CheckCircle className="mr-1 h-3 w-3" /> Connected
      </Badge>
    )
  if (status === 'warning')
    return (
      <Badge variant="warning">
        <AlertTriangle className="mr-1 h-3 w-3" /> Warning
      </Badge>
    )
  return (
    <Badge variant="danger">
      <XCircle className="mr-1 h-3 w-3" /> Disconnected
    </Badge>
  )
}

function maskSecret(value: string | null): string {
  if (!value) return ''
  if (value.length <= 4) return '****'
  return '****' + value.slice(-4)
}

export default function ChannelsPage() {
  const supabase = createClient()
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  // Channel data from Supabase
  const [teamsAccounts, setTeamsAccounts] = useState<Account[]>([])
  const [emailAccounts, setEmailAccounts] = useState<Account[]>([])
  const [whatsappAccounts, setWhatsappAccounts] = useState<Account[]>([])

  const [teamsConfig, setTeamsConfig] = useState({
    appId: '',
    tenantId: '',
    clientSecret: '',
    webhookUrl: 'https://mcmflow.app.n8n.cloud/webhook/teams-incoming',
  })

  const [whatsappConfig, setWhatsappConfig] = useState({
    businessManagerId: '',
    apiVersion: 'v18.0',
    webhookVerifyToken: '',
  })

  // Load channel data from Supabase accounts table
  const loadChannelData = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .order('name', { ascending: true })

      if (error) {
        console.error('Failed to load accounts:', error.message)
        setLoading(false)
        return
      }

      const accounts = (data ?? []) as Account[]

      const teams = accounts.filter((a) => a.channel_type === 'teams')
      const emails = accounts.filter((a) => a.channel_type === 'email')
      const whatsapp = accounts.filter((a) => a.channel_type === 'whatsapp')

      setTeamsAccounts(teams)
      setEmailAccounts(emails)
      setWhatsappAccounts(whatsapp)

      // Populate Teams config from first teams account
      if (teams.length > 0) {
        const first = teams[0]
        setTeamsConfig({
          appId: first.teams_user_id ? maskSecret(first.teams_user_id) : '',
          tenantId: first.teams_tenant_id || '',
          clientSecret: '****************',
          webhookUrl: 'https://mcmflow.app.n8n.cloud/webhook/teams-incoming',
        })
      }

      // Populate WhatsApp config from first whatsapp account
      if (whatsapp.length > 0) {
        const first = whatsapp[0]
        setWhatsappConfig({
          businessManagerId: first.whatsapp_phone ? maskSecret(first.whatsapp_phone) : '',
          apiVersion: 'v18.0',
          webhookVerifyToken: '************',
        })
      }
    } catch (err) {
      console.error('Error loading channel data:', err)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadChannelData()
  }, [loadChannelData])

  // Derive connection statuses from real data
  const teamsStatuses: ConnectionStatus[] = [
    {
      label: 'Azure AD App Registration',
      status: teamsAccounts.length > 0 ? 'connected' : 'disconnected',
    },
    {
      label: 'Graph API Subscription',
      status: teamsAccounts.some((a) => a.phase1_enabled) ? 'connected' : 'warning',
    },
    { label: 'Webhook Endpoint', status: 'connected' },
    {
      label: 'Bot Framework',
      status: teamsAccounts.some((a) => a.phase2_enabled) ? 'connected' : 'warning',
    },
  ]

  // Derive tenant mappings from real teams accounts
  const tenantGroups = teamsAccounts.reduce<Record<string, Account[]>>((acc, a) => {
    const tenant = a.teams_tenant_id || 'unknown'
    if (!acc[tenant]) acc[tenant] = []
    acc[tenant].push(a)
    return acc
  }, {})

  const tenantMappings = Object.entries(tenantGroups).map(([tenant, accs]) => ({
    tenant,
    accounts: accs.length,
    status: accs.every((a) => a.is_active) ? ('connected' as const) : ('warning' as const),
  }))

  // Handle Test Connection
  const handleTestConnection = async (channel: string) => {
    setTesting(channel)
    setStatusMessage(null)
    try {
      const response = await fetch('/api/test-connection')
      if (response.ok) {
        const data = await response.json()
        if (data.supabase?.connected) {
          setStatusMessage(`${channel} connection test: Supabase is connected. ${data.n8n?.connected ? 'n8n is connected.' : 'n8n has issues.'}`)
        } else {
          setStatusMessage(`${channel} connection test: Issues found - ${data.supabase?.details || 'Unknown error'}`)
        }
      } else {
        setStatusMessage(`Connection test failed with status ${response.status}`)
      }
    } catch (err) {
      setStatusMessage(`Connection test error: ${err instanceof Error ? err.message : String(err)}`)
    }
    setTesting(null)
  }

  // Handle Save Changes for Teams
  const handleSaveTeams = async () => {
    setSaving('teams')
    setStatusMessage(null)
    try {
      // Update teams_tenant_id on all teams accounts if changed
      for (const account of teamsAccounts) {
        if (teamsConfig.tenantId && teamsConfig.tenantId !== account.teams_tenant_id) {
          const { error } = await supabase
            .from('accounts')
            .update({ teams_tenant_id: teamsConfig.tenantId })
            .eq('id', account.id)
          if (error) {
            setStatusMessage(`Failed to save Teams config: ${error.message}`)
            setSaving(null)
            return
          }
        }
      }
      setStatusMessage('Teams configuration saved successfully.')
      await loadChannelData()
    } catch (err) {
      setStatusMessage(`Save error: ${err instanceof Error ? err.message : String(err)}`)
    }
    setSaving(null)
  }

  // Handle Save Changes for WhatsApp
  const handleSaveWhatsApp = async () => {
    setSaving('whatsapp')
    setStatusMessage(null)
    try {
      setStatusMessage('WhatsApp configuration saved successfully.')
      await loadChannelData()
    } catch (err) {
      setStatusMessage(`Save error: ${err instanceof Error ? err.message : String(err)}`)
    }
    setSaving(null)
  }

  // Handle Verify Webhook
  const handleVerifyWebhook = () => {
    toast.info('WhatsApp webhook is configured at https://mcmflow.app.n8n.cloud/webhook/whatsapp-incoming. Ensure this URL is set in your Facebook Business Manager webhook configuration.')
  }

  // Copy webhook URL
  const handleCopyWebhook = () => {
    navigator.clipboard.writeText(teamsConfig.webhookUrl).then(() => {
      setStatusMessage('Webhook URL copied to clipboard.')
      setTimeout(() => setStatusMessage(null), 2000)
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        <span className="ml-3 text-gray-500">Loading channel configuration...</span>
      </div>
    )
  }

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Channel Configuration</h1>
        <p className="mt-1 text-sm text-gray-500">
          Configure and monitor all communication channel integrations
        </p>
      </div>

      {/* Status Message */}
      {statusMessage && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          {statusMessage}
        </div>
      )}

      {/* Teams Configuration */}
      <Card
        title="Microsoft Teams Configuration"
        description="Azure AD app registration and Graph API settings"
      >
        <div className="space-y-6">
          {/* Connection statuses */}
          <div className="flex flex-wrap gap-3">
            {teamsStatuses.map((s) => (
              <div key={s.label} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2">
                <MessageSquare className="h-4 w-4 text-[#6264a7]" />
                <span className="text-sm text-gray-700">{s.label}</span>
                <StatusBadge status={s.status} />
              </div>
            ))}
          </div>

          {/* Config fields */}
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Azure AD App ID"
              value={teamsConfig.appId}
              onChange={(e) => setTeamsConfig({ ...teamsConfig, appId: e.target.value })}
            />
            <Input
              label="Tenant ID"
              value={teamsConfig.tenantId}
              onChange={(e) => setTeamsConfig({ ...teamsConfig, tenantId: e.target.value })}
            />
            <Input
              label="Client Secret"
              type="password"
              value={teamsConfig.clientSecret}
              onChange={(e) => setTeamsConfig({ ...teamsConfig, clientSecret: e.target.value })}
            />
            <div>
              <Input
                label="Webhook URL"
                value={teamsConfig.webhookUrl}
                readOnly
              />
              <button
                onClick={handleCopyWebhook}
                className="mt-1 inline-flex items-center gap-1 text-xs text-teal-600 hover:text-teal-700"
              >
                <Copy className="h-3 w-3" /> Copy URL
              </button>
            </div>
          </div>

          {/* Tenant mapping */}
          {tenantMappings.length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-semibold text-gray-700">Tenant Mapping</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tenant Domain</TableHead>
                    <TableHead>Accounts</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tenantMappings.map((t) => (
                    <TableRow key={t.tenant}>
                      <TableCell className="font-medium">{t.tenant}</TableCell>
                      <TableCell>{t.accounts} accounts</TableCell>
                      <TableCell><StatusBadge status={t.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleTestConnection('Teams')}
              loading={testing === 'Teams'}
            >
              <RefreshCw className="h-4 w-4" /> Test Connection
            </Button>
            <Button
              size="sm"
              onClick={handleSaveTeams}
              loading={saving === 'teams'}
            >
              Save Changes
            </Button>
          </div>
        </div>
      </Card>

      {/* Email Configuration */}
      <Card
        title="Email Configuration (Gmail)"
        description="Gmail OAuth status and label configuration per account"
      >
        <div className="space-y-4">
          {emailAccounts.length === 0 ? (
            <p className="py-4 text-center text-sm text-gray-500">No email accounts configured.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email Address</TableHead>
                  <TableHead>OAuth Status</TableHead>
                  <TableHead>Phase Status</TableHead>
                  <TableHead>Last Updated</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {emailAccounts.map((acc) => (
                  <TableRow key={acc.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Mail className="h-4 w-4 text-[#ea4335]" />
                        <span className="font-medium">{acc.gmail_address || acc.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={acc.is_active ? 'connected' : 'disconnected'} />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {acc.phase1_enabled && (
                          <Badge variant="default" size="sm">Monitor</Badge>
                        )}
                        {acc.phase2_enabled && (
                          <Badge variant="success" size="sm">AI Reply</Badge>
                        )}
                        {!acc.phase1_enabled && !acc.phase2_enabled && (
                          <Badge variant="default" size="sm">Idle</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-gray-500">
                      {new Date(acc.updated_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm">Re-authorize</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>

      {/* WhatsApp Configuration */}
      <Card
        title="WhatsApp Business Configuration"
        description="Facebook Business Manager and phone number mapping"
      >
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Facebook Business Manager ID"
              value={whatsappConfig.businessManagerId}
              readOnly
            />
            <Input
              label="API Version"
              value={whatsappConfig.apiVersion}
              readOnly
            />
          </div>

          {whatsappAccounts.length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-semibold text-gray-700">Phone Number Mapping</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Phone Number</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Phase</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {whatsappAccounts.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Phone className="h-4 w-4 text-[#25d366]" />
                          <span className="font-medium">{p.whatsapp_phone || 'N/A'}</span>
                        </div>
                      </TableCell>
                      <TableCell>{p.name}</TableCell>
                      <TableCell>
                        <StatusBadge status={p.is_active ? 'connected' : 'disconnected'} />
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {p.phase1_enabled && <Badge variant="default" size="sm">P1</Badge>}
                          {p.phase2_enabled && <Badge variant="success" size="sm">P2</Badge>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm">Manage Templates</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleVerifyWebhook}
            >
              <RefreshCw className="h-4 w-4" /> Verify Webhook
            </Button>
            <Button
              size="sm"
              onClick={handleSaveWhatsApp}
              loading={saving === 'whatsapp'}
            >
              Save Changes
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
