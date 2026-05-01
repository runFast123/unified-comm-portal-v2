'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase-client'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Select } from '@/components/ui/select'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import {
  Bell,
  Plus,
  Trash2,
  Edit2,
  Save,
  Link,
  Loader2,
} from 'lucide-react'

interface NotificationRule {
  id: string
  name: string
  account_id: string | null
  channel: string | null
  min_priority: string
  notify_email: boolean
  notify_in_portal: boolean
  notify_slack: boolean
  notify_email_address: string | null
  slack_webhook_url: string | null
  escalation_minutes: number
  is_active: boolean
}

const emptyFormData = {
  name: '',
  account_id: null as string | null,
  channel: null as string | null,
  min_priority: 'medium',
  notify_email: false,
  notify_in_portal: true,
  notify_slack: false,
  notify_email_address: '',
  escalation_minutes: 30,
}

function generateRuleName(rule: { channel: string | null; min_priority: string; account_id: string | null }): string {
  const channel = rule.channel ? rule.channel.charAt(0).toUpperCase() + rule.channel.slice(1) : 'All Channels'
  const priority = rule.min_priority.charAt(0).toUpperCase() + rule.min_priority.slice(1)
  const account = rule.account_id ? 'Filtered' : 'All Accounts'
  return `${priority} - ${channel} (${account})`
}

export default function NotificationsPage() {
  const supabase = createClient()
  const { toast } = useToast()
  const [rules, setRules] = useState<NotificationRule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editingRule, setEditingRule] = useState<NotificationRule | null>(null)
  const [formData, setFormData] = useState(emptyFormData)
  const [slackWebhook, setSlackWebhook] = useState('')
  const [savingWebhook, setSavingWebhook] = useState(false)
  const [testingSlack, setTestingSlack] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)

  // Load notification rules from Supabase
  const loadRules = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('notification_rules')
        .select('*')
        .order('created_at', { ascending: true })

      if (error) {
        console.error('Failed to load notification rules:', error.message)
        setStatusMessage(`Failed to load rules: ${error.message}`)
        setLoading(false)
        return
      }

      const mapped: NotificationRule[] = (data ?? []).map((row: Record<string, unknown>) => ({
        id: row.id as string,
        name: (row.name as string) || generateRuleName({
          channel: row.channel as string | null,
          min_priority: (row.min_priority as string) || 'medium',
          account_id: row.account_id as string | null,
        }),
        account_id: row.account_id as string | null,
        channel: row.channel as string | null,
        min_priority: (row.min_priority as string) || 'medium',
        notify_email: row.notify_email as boolean,
        notify_in_portal: row.notify_in_portal as boolean,
        notify_slack: row.notify_slack as boolean,
        notify_email_address: (row.notify_email_address as string) || null,
        slack_webhook_url: row.slack_webhook_url as string | null,
        escalation_minutes: (row.escalation_minutes as number) || 30,
        is_active: row.is_active as boolean,
      }))

      setRules(mapped)

      // Load slack webhook from first rule that has one
      const ruleWithWebhook = mapped.find((r) => r.slack_webhook_url)
      if (ruleWithWebhook?.slack_webhook_url) {
        setSlackWebhook(ruleWithWebhook.slack_webhook_url)
      }
    } catch (err) {
      console.error('Error loading rules:', err)
      setStatusMessage('Error loading notification rules.')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadRules()
  }, [loadRules])

  const openAddModal = () => {
    setEditingRule(null)
    setFormData(emptyFormData)
    setValidationError(null)
    setShowModal(true)
  }

  const openEditModal = (rule: NotificationRule) => {
    setEditingRule(rule)
    setFormData({
      name: rule.name,
      account_id: rule.account_id,
      channel: rule.channel,
      min_priority: rule.min_priority,
      notify_email: rule.notify_email,
      notify_in_portal: rule.notify_in_portal,
      notify_slack: rule.notify_slack,
      notify_email_address: rule.notify_email_address || '',
      escalation_minutes: rule.escalation_minutes,
    })
    setValidationError(null)
    setShowModal(true)
  }

  const validateForm = (): boolean => {
    if (!formData.name.trim()) {
      setValidationError('Rule name is required.')
      return false
    }
    if (!formData.notify_email && !formData.notify_in_portal && !formData.notify_slack) {
      setValidationError('At least one notification method must be selected.')
      return false
    }
    setValidationError(null)
    return true
  }

  const handleSave = async () => {
    if (!validateForm()) return

    setSaving(true)
    setStatusMessage(null)

    const dbRecord = {
      account_id: formData.account_id || null,
      channel: formData.channel || null,
      min_priority: formData.min_priority,
      notify_email: formData.notify_email,
      notify_email_address: formData.notify_email ? formData.notify_email_address || null : null,
      notify_in_portal: formData.notify_in_portal,
      notify_slack: formData.notify_slack,
      slack_webhook_url: formData.notify_slack ? slackWebhook || null : null,
      escalation_minutes: formData.escalation_minutes,
    }

    try {
      if (editingRule) {
        const { error } = await supabase
          .from('notification_rules')
          .update(dbRecord)
          .eq('id', editingRule.id)

        if (error) {
          setStatusMessage(`Failed to update rule: ${error.message}`)
          setSaving(false)
          return
        }
        setStatusMessage('Rule updated successfully.')
      } else {
        const { error } = await supabase
          .from('notification_rules')
          .insert({ ...dbRecord, is_active: true })

        if (error) {
          setStatusMessage(`Failed to create rule: ${error.message}`)
          setSaving(false)
          return
        }
        setStatusMessage('Rule created successfully.')
      }

      setShowModal(false)
      await loadRules()
    } catch (err) {
      setStatusMessage(`Error saving rule: ${err instanceof Error ? err.message : String(err)}`)
    }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this notification rule?')) return
    setStatusMessage(null)
    try {
      const { error } = await supabase
        .from('notification_rules')
        .delete()
        .eq('id', id)

      if (error) {
        setStatusMessage(`Failed to delete rule: ${error.message}`)
        return
      }

      setRules((prev) => prev.filter((r) => r.id !== id))
      setStatusMessage('Rule deleted.')
    } catch (err) {
      setStatusMessage(`Error deleting rule: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const toggleEnabled = async (id: string) => {
    const rule = rules.find((r) => r.id === id)
    if (!rule) return

    const newValue = !rule.is_active

    // Optimistic update
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, is_active: newValue } : r))
    )

    const { error } = await supabase
      .from('notification_rules')
      .update({ is_active: newValue })
      .eq('id', id)

    if (error) {
      console.error('Failed to toggle rule:', error.message)
      // Revert
      setRules((prev) =>
        prev.map((r) => (r.id === id ? { ...r, is_active: !newValue } : r))
      )
      setStatusMessage(`Failed to toggle rule: ${error.message}`)
    }
  }

  const handleTestSlack = async () => {
    const url = slackWebhook.trim()
    if (!url) {
      toast.warning('Please enter a Slack webhook URL first.')
      return
    }
    setTestingSlack(true)
    try {
      const res = await fetch('/api/admin/notifications/test-slack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: url }),
      })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (res.ok && data.ok) {
        toast.success('Test message sent to Slack.')
      } else {
        toast.error(data.error || `Slack test failed (${res.status}).`)
      }
    } catch (err) {
      toast.error(`Slack test failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    setTestingSlack(false)
  }

  const handleSaveWebhook = async () => {
    setSavingWebhook(true)
    setStatusMessage(null)
    try {
      // Update slack_webhook_url on all rules that have notify_slack enabled
      const slackRules = rules.filter((r) => r.notify_slack)
      for (const rule of slackRules) {
        await supabase
          .from('notification_rules')
          .update({ slack_webhook_url: slackWebhook || null })
          .eq('id', rule.id)
      }
      setStatusMessage('Slack webhook URL saved.')
    } catch (err) {
      setStatusMessage(`Error saving webhook: ${err instanceof Error ? err.message : String(err)}`)
    }
    setSavingWebhook(false)
  }

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'urgent':
        return <Badge variant="danger">Urgent</Badge>
      case 'high':
        return <Badge variant="warning">High</Badge>
      case 'medium':
        return <Badge variant="info">Medium</Badge>
      default:
        return <Badge variant="default">Low</Badge>
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        <span className="ml-3 text-gray-500">Loading notification rules...</span>
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Notification Rules</h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure when and how you receive notifications about incoming messages
          </p>
        </div>
        <Button onClick={openAddModal}>
          <Plus className="h-4 w-4" /> Add Rule
        </Button>
      </div>

      {/* Status Message */}
      {statusMessage && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          {statusMessage}
        </div>
      )}

      {/* Slack Webhook Configuration */}
      <Card title="Slack Integration" description="Configure the Slack Incoming Webhook for notifications">
        <div className="flex items-end gap-4">
          <div className="flex-1">
            <Input
              label="Slack Webhook URL"
              value={slackWebhook}
              onChange={(e) => setSlackWebhook(e.target.value)}
              icon={<Link className="h-4 w-4" />}
              placeholder="https://hooks.slack.com/services/..."
            />
            <p className="mt-1 text-xs text-gray-500">
              Need one? See{' '}
              <a
                href="https://api.slack.com/messaging/webhooks"
                target="_blank"
                rel="noreferrer"
                className="text-teal-600 hover:underline"
              >
                Slack Incoming Webhooks docs
              </a>{' '}
              to create a webhook for your workspace.
            </p>
          </div>
          <Button
            variant="secondary"
            size="md"
            onClick={handleTestSlack}
            loading={testingSlack}
          >
            Send test
          </Button>
          <Button size="md" onClick={handleSaveWebhook} loading={savingWebhook}>
            <Save className="h-4 w-4" /> Save
          </Button>
        </div>
      </Card>

      {/* Rules Table */}
      <Card>
        {rules.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-500">
            <Bell className="h-8 w-8 text-gray-300 mb-2" />
            <p className="font-medium text-gray-700">No notification rules configured</p>
            <p className="text-sm mt-1">Click "Add Rule" to create your first notification rule.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rule Name</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Min Priority</TableHead>
                <TableHead>Notification Methods</TableHead>
                <TableHead>Escalation</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Bell className="h-4 w-4 text-gray-400" />
                      <span className="font-medium text-gray-900">{rule.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {rule.channel
                      ? rule.channel.charAt(0).toUpperCase() + rule.channel.slice(1)
                      : 'All'}
                  </TableCell>
                  <TableCell>{getPriorityBadge(rule.min_priority)}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {rule.notify_email && (
                        <Badge variant="default" size="sm">Email</Badge>
                      )}
                      {rule.notify_in_portal && (
                        <Badge variant="info" size="sm">Portal</Badge>
                      )}
                      {rule.notify_slack && (
                        <Badge variant="teams" size="sm">Slack</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{rule.escalation_minutes} min</TableCell>
                  <TableCell>
                    <button
                      onClick={() => toggleEnabled(rule.id)}
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                        rule.is_active
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {rule.is_active ? 'Active' : 'Disabled'}
                    </button>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEditModal(rule)}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(rule.id)}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Add/Edit Modal */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={editingRule ? 'Edit Notification Rule' : 'Add Notification Rule'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!formData.name.trim()} loading={saving}>
              {editingRule ? 'Update Rule' : 'Create Rule'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {validationError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {validationError}
            </div>
          )}

          <Input
            label="Rule Name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="e.g., Urgent Escalation"
          />

          <Select
            label="Channel Filter"
            value={formData.channel || 'all'}
            onChange={(e) =>
              setFormData({ ...formData, channel: e.target.value === 'all' ? null : e.target.value })
            }
            options={[
              { value: 'all', label: 'All Channels' },
              { value: 'teams', label: 'Teams' },
              { value: 'email', label: 'Email' },
              { value: 'whatsapp', label: 'WhatsApp' },
            ]}
          />

          <Select
            label="Minimum Priority"
            value={formData.min_priority}
            onChange={(e) => setFormData({ ...formData, min_priority: e.target.value })}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'urgent', label: 'Urgent' },
            ]}
          />

          <div>
            <p className="mb-2 text-sm font-medium text-gray-700">Notification Methods</p>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.notify_email}
                  onChange={(e) => setFormData({ ...formData, notify_email: e.target.checked })}
                  className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                />
                <span className="text-sm text-gray-700">Email</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.notify_in_portal}
                  onChange={(e) => setFormData({ ...formData, notify_in_portal: e.target.checked })}
                  className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                />
                <span className="text-sm text-gray-700">Portal</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.notify_slack}
                  onChange={(e) => setFormData({ ...formData, notify_slack: e.target.checked })}
                  className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                />
                <span className="text-sm text-gray-700">Slack</span>
              </label>
            </div>
          </div>

          {formData.notify_email && (
            <Input
              label="Notification Email Address"
              type="email"
              value={formData.notify_email_address}
              onChange={(e) => setFormData({ ...formData, notify_email_address: e.target.value })}
              placeholder="admin@example.com"
            />
          )}

          <Input
            label="Escalation Time (minutes)"
            type="number"
            min={5}
            max={1440}
            value={formData.escalation_minutes.toString()}
            onChange={(e) =>
              setFormData({ ...formData, escalation_minutes: parseInt(e.target.value) || 30 })
            }
          />
        </div>
      </Modal>
    </div>
  )
}
