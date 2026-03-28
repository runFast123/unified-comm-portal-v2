'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  XCircle,
  MessageSquare,
  Mail,
  Phone,
  FileSpreadsheet,
  Workflow,
  Database,
  Brain,
  Server,
} from 'lucide-react'

type HealthStatus = 'healthy' | 'warning' | 'error'

interface ServiceCheck {
  label: string
  status: HealthStatus
  detail: string
}

interface ServiceCard {
  name: string
  icon: React.ReactNode
  checks: ServiceCheck[]
}

function StatusIcon({ status }: { status: HealthStatus }) {
  switch (status) {
    case 'healthy':
      return <CheckCircle className="h-4 w-4 text-green-500" />
    case 'warning':
      return <AlertTriangle className="h-4 w-4 text-yellow-500" />
    case 'error':
      return <XCircle className="h-4 w-4 text-red-500" />
  }
}

function StatusBadge({ status }: { status: HealthStatus }) {
  switch (status) {
    case 'healthy':
      return <Badge variant="success">Healthy</Badge>
    case 'warning':
      return <Badge variant="warning">Warning</Badge>
    case 'error':
      return <Badge variant="danger">Error</Badge>
  }
}

function getOverallStatus(checks: ServiceCheck[]): HealthStatus {
  if (checks.some((c) => c.status === 'error')) return 'error'
  if (checks.some((c) => c.status === 'warning')) return 'warning'
  return 'healthy'
}

export default function HealthPage() {
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [services, setServices] = useState<ServiceCard[]>([])

  const runHealthChecks = useCallback(async () => {
    setRefreshing(true)

    const newServices: ServiceCard[] = []

    // ---- Check Supabase & n8n & env vars via /api/test-connection ----
    let testData: {
      supabase?: { status: string; details: string; connected: boolean }
      n8n?: { status: string; details: string; connected: boolean }
      env_vars?: Record<string, boolean>
    } = {}

    try {
      const response = await fetch('/api/test-connection')
      if (response.ok) {
        testData = await response.json()
      }
    } catch {
      // Will show as error below
    }

    // Supabase service card
    const supabaseStatus = testData.supabase?.connected
      ? testData.supabase.status === 'connected'
        ? 'healthy'
        : 'warning'
      : 'error'

    newServices.push({
      name: 'Supabase',
      icon: <Database className="h-6 w-6 text-emerald-600" />,
      checks: [
        {
          label: 'Connection',
          status: supabaseStatus as HealthStatus,
          detail: testData.supabase?.details || 'Unable to reach test endpoint',
        },
        {
          label: 'URL Configured',
          status: testData.env_vars?.NEXT_PUBLIC_SUPABASE_URL ? 'healthy' : 'error',
          detail: testData.env_vars?.NEXT_PUBLIC_SUPABASE_URL ? 'NEXT_PUBLIC_SUPABASE_URL is set' : 'Missing NEXT_PUBLIC_SUPABASE_URL',
        },
        {
          label: 'Anon Key',
          status: testData.env_vars?.NEXT_PUBLIC_SUPABASE_ANON_KEY ? 'healthy' : 'error',
          detail: testData.env_vars?.NEXT_PUBLIC_SUPABASE_ANON_KEY ? 'NEXT_PUBLIC_SUPABASE_ANON_KEY is set' : 'Missing anon key',
        },
        {
          label: 'Service Role Key',
          status: testData.env_vars?.SUPABASE_SERVICE_ROLE_KEY ? 'healthy' : 'warning',
          detail: testData.env_vars?.SUPABASE_SERVICE_ROLE_KEY ? 'Service role key configured' : 'Service role key not set (optional)',
        },
      ],
    })

    // n8n service card
    const n8nStatus = testData.n8n?.connected
      ? testData.n8n.status === 'connected'
        ? 'healthy'
        : 'warning'
      : 'error'

    newServices.push({
      name: 'n8n Automation',
      icon: <Workflow className="h-6 w-6 text-orange-500" />,
      checks: [
        {
          label: 'Connection',
          status: n8nStatus as HealthStatus,
          detail: testData.n8n?.details || 'Unable to reach n8n',
        },
        {
          label: 'Base URL',
          status: testData.env_vars?.N8N_BASE_URL ? 'healthy' : 'error',
          detail: testData.env_vars?.N8N_BASE_URL ? 'N8N_BASE_URL is set' : 'Missing N8N_BASE_URL',
        },
        {
          label: 'API Key',
          status: testData.env_vars?.N8N_API_KEY ? 'healthy' : 'warning',
          detail: testData.env_vars?.N8N_API_KEY ? 'N8N_API_KEY configured' : 'N8N_API_KEY not set',
        },
        {
          label: 'Webhook Secret',
          status: testData.env_vars?.N8N_WEBHOOK_SECRET ? 'healthy' : 'warning',
          detail: testData.env_vars?.N8N_WEBHOOK_SECRET ? 'Webhook secret configured' : 'Webhook secret not set',
        },
      ],
    })

    // AI Engine service card
    newServices.push({
      name: 'AI Engine',
      icon: <Brain className="h-6 w-6 text-purple-600" />,
      checks: [
        {
          label: 'API Key',
          status: testData.env_vars?.AI_API_KEY ? 'healthy' : 'error',
          detail: testData.env_vars?.AI_API_KEY ? 'AI_API_KEY is configured' : 'AI_API_KEY not set - configure in Admin > AI Settings',
        },
      ],
    })

    // Channel status cards (based on Supabase data if connected)
    // These show basic connectivity info since we know Supabase is the source of truth
    newServices.push({
      name: 'Microsoft Graph API',
      icon: <MessageSquare className="h-6 w-6 text-[#6264a7]" />,
      checks: [
        {
          label: 'Supabase Backend',
          status: supabaseStatus as HealthStatus,
          detail: supabaseStatus === 'healthy' ? 'Teams accounts accessible via Supabase' : 'Cannot verify - Supabase not connected',
        },
      ],
    })

    newServices.push({
      name: 'Gmail API',
      icon: <Mail className="h-6 w-6 text-[#ea4335]" />,
      checks: [
        {
          label: 'Supabase Backend',
          status: supabaseStatus as HealthStatus,
          detail: supabaseStatus === 'healthy' ? 'Email accounts accessible via Supabase' : 'Cannot verify - Supabase not connected',
        },
      ],
    })

    newServices.push({
      name: 'WhatsApp Business API',
      icon: <Phone className="h-6 w-6 text-[#25d366]" />,
      checks: [
        {
          label: 'Supabase Backend',
          status: supabaseStatus as HealthStatus,
          detail: supabaseStatus === 'healthy' ? 'WhatsApp accounts accessible via Supabase' : 'Cannot verify - Supabase not connected',
        },
      ],
    })

    newServices.push({
      name: 'Google Sheets API',
      icon: <FileSpreadsheet className="h-6 w-6 text-green-600" />,
      checks: [
        {
          label: 'Supabase Backend',
          status: supabaseStatus as HealthStatus,
          detail: supabaseStatus === 'healthy' ? 'Sheet sync configs accessible via Supabase' : 'Cannot verify - Supabase not connected',
        },
      ],
    })

    setServices(newServices)
    setLastRefresh(new Date())
    setRefreshing(false)
  }, [])

  useEffect(() => {
    runHealthChecks()
  }, [runHealthChecks])

  const totalChecks = services.reduce((sum, s) => sum + s.checks.length, 0)
  const healthyChecks = services.reduce(
    (sum, s) => sum + s.checks.filter((c) => c.status === 'healthy').length,
    0
  )
  const warningChecks = services.reduce(
    (sum, s) => sum + s.checks.filter((c) => c.status === 'warning').length,
    0
  )
  const errorChecks = services.reduce(
    (sum, s) => sum + s.checks.filter((c) => c.status === 'error').length,
    0
  )

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">System Health</h1>
          <p className="mt-1 text-sm text-gray-500">
            Monitor the status of all integrated services and APIs
          </p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">
            Last refreshed: {lastRefresh ? lastRefresh.toLocaleTimeString() : 'Never'}
          </span>
          <Button variant="secondary" onClick={runHealthChecks} loading={refreshing}>
            <RefreshCw className="h-4 w-4" /> Refresh All
          </Button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-6 rounded-xl border border-gray-200 bg-white px-6 py-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5 text-gray-400" />
          <span className="text-sm font-medium text-gray-700">{services.length} Services</span>
        </div>
        <div className="h-6 w-px bg-gray-200" />
        <div className="flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-green-500" />
          <span className="text-sm text-gray-700">{healthyChecks} Healthy</span>
        </div>
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-yellow-500" />
          <span className="text-sm text-gray-700">{warningChecks} Warnings</span>
        </div>
        <div className="flex items-center gap-2">
          <XCircle className="h-4 w-4 text-red-500" />
          <span className="text-sm text-gray-700">{errorChecks} Errors</span>
        </div>
        <div className="ml-auto">
          <span className="text-sm text-gray-500">
            {totalChecks} checks total
          </span>
        </div>
      </div>

      {/* Service cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {services.map((service) => {
          const overall = getOverallStatus(service.checks)
          return (
            <Card key={service.name}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg border border-gray-100 bg-gray-50 p-2">
                    {service.icon}
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900">{service.name}</h3>
                    <StatusBadge status={overall} />
                  </div>
                </div>
                <div
                  className={`h-3 w-3 rounded-full ${
                    overall === 'healthy'
                      ? 'bg-green-500'
                      : overall === 'warning'
                      ? 'bg-yellow-500'
                      : 'bg-red-500'
                  }`}
                />
              </div>

              <div className="mt-4 space-y-2">
                {service.checks.map((check) => (
                  <div
                    key={check.label}
                    className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <StatusIcon status={check.status} />
                      <span className="text-sm font-medium text-gray-700">{check.label}</span>
                    </div>
                    <span className="text-xs text-gray-500 max-w-[250px] truncate" title={check.detail}>
                      {check.detail}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
