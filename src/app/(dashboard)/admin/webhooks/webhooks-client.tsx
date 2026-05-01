'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Webhook,
  Plus,
  AlertCircle,
  ShieldAlert,
  Trash2,
  Send,
  CheckCircle2,
  PauseCircle,
  PlayCircle,
  XCircle,
  Activity,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input } from '@/components/ui/input'
import { CopyField } from '@/components/ui/copy-field'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/toast'
import { Badge } from '@/components/ui/badge'

export interface WebhookRow {
  id: string
  company_id: string
  url: string
  events: string[]
  is_active: boolean
  created_at: string
  last_delivery_at: string | null
  consecutive_failures: number
}

interface DeliveryRow {
  id: string
  event_type: string
  http_status: number | null
  attempted_at: string
  duration_ms: number | null
  error: string | null
  retry_count: number
  payload_excerpt: string | null
}

interface Props {
  initialWebhooks: WebhookRow[]
  knownEvents: string[]
  canCreate: boolean
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

function statusOf(w: WebhookRow): { label: string; variant: 'success' | 'warning' | 'default' } {
  if (!w.is_active) return { label: 'Paused', variant: 'warning' }
  if (w.consecutive_failures >= 3) return { label: 'Failing', variant: 'warning' }
  return { label: 'Active', variant: 'success' }
}

export function WebhooksClient({ initialWebhooks, knownEvents, canCreate }: Props) {
  const router = useRouter()
  const { toast } = useToast()
  const [webhooks, setWebhooks] = useState<WebhookRow[]>(initialWebhooks)

  // Create modal
  const [createOpen, setCreateOpen] = useState(false)
  const [createUrl, setCreateUrl] = useState('')
  const [createEvents, setCreateEvents] = useState<string[]>(['conversation.created', 'message.received'])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [secretModal, setSecretModal] = useState<{ url: string; signing_secret: string } | null>(null)

  // Deliveries modal
  const [deliveriesOpen, setDeliveriesOpen] = useState(false)
  const [deliveriesFor, setDeliveriesFor] = useState<WebhookRow | null>(null)
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([])
  const [deliveriesLoading, setDeliveriesLoading] = useState(false)

  const toggleEvent = useCallback((event: string) => {
    setCreateEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    )
  }, [])

  const handleCreate = useCallback(async () => {
    if (!createUrl.trim()) {
      setCreateError('URL is required')
      return
    }
    if (createEvents.length === 0) {
      setCreateError('Select at least one event')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch('/api/admin/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: createUrl.trim(), events: createEvents }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCreateError(data?.error ?? 'Failed to create webhook')
        return
      }
      setWebhooks((prev) => [
        {
          id: data.webhook.id,
          company_id: data.webhook.company_id,
          url: data.webhook.url,
          events: data.webhook.events,
          is_active: data.webhook.is_active,
          created_at: data.webhook.created_at,
          last_delivery_at: null,
          consecutive_failures: 0,
        },
        ...prev,
      ])
      setCreateOpen(false)
      setCreateUrl('')
      setCreateEvents(['conversation.created', 'message.received'])
      setSecretModal({ url: data.webhook.url, signing_secret: data.signing_secret })
      router.refresh()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setCreating(false)
    }
  }, [createUrl, createEvents, router])

  const handleToggleActive = useCallback(
    async (w: WebhookRow) => {
      try {
        const res = await fetch(`/api/admin/webhooks/${w.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: !w.is_active }),
        })
        const data = await res.json()
        if (!res.ok) {
          toast.error(data?.error ?? 'Failed to update webhook')
          return
        }
        setWebhooks((prev) =>
          prev.map((row) =>
            row.id === w.id
              ? {
                  ...row,
                  is_active: data.webhook.is_active,
                  consecutive_failures: data.webhook.consecutive_failures ?? row.consecutive_failures,
                }
              : row,
          ),
        )
        toast.success(data.webhook.is_active ? 'Webhook resumed' : 'Webhook paused')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      }
    },
    [toast],
  )

  const handleDelete = useCallback(
    async (w: WebhookRow) => {
      const ok = window.confirm(`Delete webhook for ${w.url}?\nThis cannot be undone.`)
      if (!ok) return
      try {
        const res = await fetch(`/api/admin/webhooks/${w.id}`, { method: 'DELETE' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data?.error ?? 'Failed to delete webhook')
          return
        }
        setWebhooks((prev) => prev.filter((row) => row.id !== w.id))
        toast.success('Webhook deleted')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      }
    },
    [toast],
  )

  const handleTest = useCallback(
    async (w: WebhookRow) => {
      try {
        const res = await fetch(`/api/admin/webhooks/${w.id}/test`, { method: 'POST' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data?.error ?? 'Test failed to queue')
          return
        }
        toast.success('Test event queued. Check deliveries in a few seconds.')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      }
    },
    [toast],
  )

  const openDeliveries = useCallback(
    async (w: WebhookRow) => {
      setDeliveriesFor(w)
      setDeliveriesOpen(true)
      setDeliveriesLoading(true)
      setDeliveries([])
      try {
        const res = await fetch(`/api/admin/webhooks/${w.id}/deliveries`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data?.error ?? 'Failed to load deliveries')
        } else {
          setDeliveries((data.deliveries ?? []) as DeliveryRow[])
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      } finally {
        setDeliveriesLoading(false)
      }
    },
    [toast],
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Webhook className="h-6 w-6 text-teal-700" />
            Webhooks
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Receive real-time HTTP POSTs when events happen in this company. Each delivery is signed
            with HMAC-SHA256 in the <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">X-Webhook-Signature</code> header.
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> Add webhook
          </Button>
        )}
      </div>

      <Card>
        {webhooks.length === 0 ? (
          <EmptyState
            icon={<Webhook className="h-12 w-12" />}
            title="No webhooks configured"
            description="Add a webhook to push conversation and message events to an external system in real time."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>URL</TableHead>
                <TableHead>Events</TableHead>
                <TableHead className="hidden md:table-cell">Last delivery</TableHead>
                <TableHead className="text-right">Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {webhooks.map((w) => {
                const status = statusOf(w)
                return (
                  <TableRow
                    key={w.id}
                    className="cursor-pointer hover:bg-gray-50"
                    onClick={() => openDeliveries(w)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2 max-w-xl">
                        <span className="truncate font-mono text-xs text-gray-800" title={w.url}>
                          {w.url}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {w.events.map((e) => (
                          <Badge key={e} variant="info">
                            {e}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-gray-600">
                      {formatDate(w.last_delivery_at)}
                      {w.consecutive_failures > 0 && (
                        <span className="ml-2 text-xs text-amber-700">
                          ({w.consecutive_failures} failures)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleTest(w)}
                          title="Send a test event"
                        >
                          <Send className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleActive(w)}
                          title={w.is_active ? 'Pause webhook' : 'Resume webhook'}
                        >
                          {w.is_active ? (
                            <PauseCircle className="h-4 w-4" />
                          ) : (
                            <PlayCircle className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(w)}
                          title="Delete webhook"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* ── Create modal ───────────────────────────────────────────── */}
      <Modal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false)
          setCreateError(null)
        }}
        title="Add webhook"
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
            <Button
              onClick={handleCreate}
              disabled={creating || !createUrl.trim() || createEvents.length === 0}
              loading={creating}
            >
              <Plus className="h-4 w-4" /> Add
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
            label="URL"
            type="url"
            placeholder="https://example.com/webhook"
            value={createUrl}
            onChange={(e) => setCreateUrl(e.target.value)}
            autoFocus
          />
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Events</label>
            <div className="space-y-2 rounded-lg border border-gray-200 p-3">
              {knownEvents.map((event) => (
                <label
                  key={event}
                  className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={createEvents.includes(event)}
                    onChange={() => toggleEvent(event)}
                    className="h-4 w-4 rounded border-gray-300 text-teal-700 focus:ring-teal-500"
                  />
                  <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">
                    {event}
                  </code>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* ── Signing secret one-time modal ──────────────────────────── */}
      <Modal
        open={secretModal !== null}
        onClose={() => setSecretModal(null)}
        title="Save your signing secret"
        footer={
          <Button onClick={() => setSecretModal(null)}>
            <CheckCircle2 className="h-4 w-4" /> I have saved the secret
          </Button>
        }
      >
        {secretModal && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 text-amber-700 flex-shrink-0" />
              <div className="text-sm text-amber-800">
                <p className="font-semibold">This is the only time you&apos;ll see this secret.</p>
                <p className="mt-1">
                  Use it to verify the <code>X-Webhook-Signature: sha256=&lt;hex&gt;</code> header on
                  every delivery. We never display it again — if you lose it, delete this webhook
                  and create a new one.
                </p>
              </div>
            </div>
            <p className="text-sm text-gray-700">
              Webhook for <strong className="font-mono text-xs">{secretModal.url}</strong>:
            </p>
            <CopyField
              label="Signing secret"
              value={secretModal.signing_secret}
              helpText="HMAC-SHA256(secret, raw_body) === signature_header_value (after stripping the 'sha256=' prefix)."
            />
          </div>
        )}
      </Modal>

      {/* ── Deliveries modal ───────────────────────────────────────── */}
      <Modal
        open={deliveriesOpen}
        onClose={() => {
          setDeliveriesOpen(false)
          setDeliveriesFor(null)
        }}
        title={deliveriesFor ? `Recent deliveries — ${deliveriesFor.url}` : 'Recent deliveries'}
        className="sm:max-w-3xl"
        footer={
          <Button
            variant="secondary"
            onClick={() => {
              setDeliveriesOpen(false)
              setDeliveriesFor(null)
            }}
          >
            Close
          </Button>
        }
      >
        {deliveriesLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-gray-500">
            <Activity className="mr-2 h-4 w-4 animate-pulse" />
            Loading…
          </div>
        ) : deliveries.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">No deliveries yet.</p>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <th className="py-2 pr-2">When</th>
                  <th className="py-2 pr-2">Event</th>
                  <th className="py-2 pr-2">HTTP</th>
                  <th className="py-2 pr-2">Duration</th>
                  <th className="py-2 pr-2">Retry</th>
                  <th className="py-2 pr-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => {
                  const ok = d.http_status != null && d.http_status >= 200 && d.http_status < 300
                  return (
                    <tr key={d.id} className="border-b border-gray-100">
                      <td className="py-2 pr-2 text-xs text-gray-600">
                        {formatDate(d.attempted_at)}
                      </td>
                      <td className="py-2 pr-2">
                        <code className="text-xs">{d.event_type}</code>
                      </td>
                      <td className="py-2 pr-2">
                        {d.http_status == null ? (
                          <span className="inline-flex items-center gap-1 text-xs text-red-700">
                            <XCircle className="h-3 w-3" /> error
                          </span>
                        ) : ok ? (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                            <CheckCircle2 className="h-3 w-3" /> {d.http_status}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-red-700">
                            <XCircle className="h-3 w-3" /> {d.http_status}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-xs text-gray-600">
                        {d.duration_ms != null ? `${d.duration_ms} ms` : '—'}
                      </td>
                      <td className="py-2 pr-2 text-xs text-gray-600">{d.retry_count}</td>
                      <td className="py-2 pr-2 text-xs text-gray-600 max-w-md truncate" title={d.error ?? ''}>
                        {d.error ?? '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  )
}
