'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase-client'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import type { GoogleSheetsSync, SyncStatus } from '@/types/database'
import {
  FileSpreadsheet,
  Plus,
  RefreshCw,
  ExternalLink,
  Clock,
  CheckCircle,
  AlertTriangle,
  Loader2,
  ArrowRight,
  GripVertical,
  Trash2,
} from 'lucide-react'

const availableColumns = [
  'external_id',
  'entity_name',
  'category',
  'data_json.description',
  'data_json.status',
  'data_json.priority',
  'data_json.assignee',
  'data_json.created_date',
]

function SyncStatusBadge({ status }: { status: SyncStatus }) {
  switch (status) {
    case 'active':
      return (
        <Badge variant="success">
          <CheckCircle className="mr-1 h-3 w-3" /> Active
        </Badge>
      )
    case 'paused':
      return (
        <Badge variant="warning">
          <Clock className="mr-1 h-3 w-3" /> Paused
        </Badge>
      )
    case 'error':
      return (
        <Badge variant="danger">
          <AlertTriangle className="mr-1 h-3 w-3" /> Error
        </Badge>
      )
    case 'syncing':
      return (
        <Badge variant="info">
          <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Syncing
        </Badge>
      )
  }
}

import { useUser } from '@/context/user-context'

interface AccountOption { id: string; name: string }

export default function SheetsPage() {
  const { isAdmin, account_id: userAccountId } = useUser()
  const supabase = createClient()
  const [sheets, setSheets] = useState<GoogleSheetsSync[]>([])
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddSheet, setShowAddSheet] = useState(false)
  const [newSheetUrl, setNewSheetUrl] = useState('')
  const [newSheetName, setNewSheetName] = useState('')
  const [newSheetAccountId, setNewSheetAccountId] = useState('')
  const [addingSheet, setAddingSheet] = useState(false)
  const [selectedSheet, setSelectedSheet] = useState<GoogleSheetsSync | null>(null)
  const [editedMapping, setEditedMapping] = useState<Record<string, string>>({})
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [savingMapping, setSavingMapping] = useState(false)

  // Load accounts for company selector
  useEffect(() => {
    async function fetchAccounts() {
      let query = supabase
        .from('accounts')
        .select('id, name')
        .eq('is_active', true)
        .order('name')
      if (!isAdmin && userAccountId) query = query.eq('id', userAccountId)
      const { data } = await query
      if (data) setAccounts(data)
    }
    fetchAccounts()
  }, [isAdmin, userAccountId])

  // Helper to get account name
  function getAccountName(accountId: string | null): string {
    if (!accountId) return 'General'
    return accounts.find(a => a.id === accountId)?.name || 'Unknown'
  }

  // Load sheets from Supabase
  const loadSheets = useCallback(async () => {
    setLoading(true)
    try {
      let query = supabase
        .from('google_sheets_sync')
        .select('*')
        .order('created_at', { ascending: false })
      // Non-admins: only see sheets for their company or shared
      if (!isAdmin && userAccountId) {
        query = query.or(`account_id.eq.${userAccountId},account_id.is.null`)
      }
      const { data, error } = await query

      if (error) {
        console.error('Failed to load sheets:', error.message)
        setStatusMessage(`Failed to load sheets: ${error.message}`)
        setLoading(false)
        return
      }

      setSheets((data ?? []) as GoogleSheetsSync[])
    } catch (err) {
      console.error('Error loading sheets:', err)
      setStatusMessage('Error loading sheet configurations.')
    }
    setLoading(false)
  }, [isAdmin, userAccountId])

  useEffect(() => {
    loadSheets()
  }, [loadSheets])

  // Extract sheet ID from Google Sheets URL
  const extractSheetId = (url: string): string | null => {
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
    return match ? match[1] : null
  }

  const handleAddSheet = async () => {
    if (!newSheetUrl) return

    const sheetId = extractSheetId(newSheetUrl)
    if (!sheetId) {
      setStatusMessage('Invalid Google Sheets URL. Please use a URL like: https://docs.google.com/spreadsheets/d/...')
      return
    }

    setAddingSheet(true)
    setStatusMessage(null)

    const detectedName = newSheetName || 'Sheet1'
    const newSheet = {
      sheet_id: sheetId,
      sheet_name: detectedName,
      sheet_url: newSheetUrl,
      account_id: (!isAdmin && userAccountId) ? userAccountId : (newSheetAccountId || null),
      sync_status: 'paused' as SyncStatus,
      row_count: 0,
      sync_schedule: 'Every 30 minutes',
      column_mapping: null,
    }

    try {
      const { error } = await supabase
        .from('google_sheets_sync')
        .insert(newSheet)

      if (error) {
        setStatusMessage(`Failed to add sheet: ${error.message}`)
        setAddingSheet(false)
        return
      }

      setNewSheetUrl('')
      setNewSheetName('')
      setNewSheetAccountId('')
      setShowAddSheet(false)
      setStatusMessage('Sheet added successfully.')
      await loadSheets()
    } catch (err) {
      setStatusMessage(`Error adding sheet: ${err instanceof Error ? err.message : String(err)}`)
    }
    setAddingSheet(false)
  }

  const handleSyncNow = async (id: string) => {
    setSyncingId(id)
    setStatusMessage(null)

    // Optimistic: show syncing status
    setSheets((prev) =>
      prev.map((s) => (s.id === id ? { ...s, sync_status: 'syncing' as SyncStatus } : s))
    )

    try {
      const response = await fetch('/api/sheets-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_sync_id: id }),
      })

      if (response.ok) {
        const data = await response.json()
        const result = data.synced?.[0]
        if (result?.status === 'error') {
          setStatusMessage(`Sync failed: ${result.error || 'Unknown error'}`)
        } else if (result) {
          setStatusMessage(`Sync complete: ${result.rows_synced} rows synced for "${result.sheet_name}".`)
        } else {
          setStatusMessage('Sync complete.')
        }
      } else {
        const errorData = await response.json().catch(() => ({}))
        setStatusMessage(`Sync failed: ${errorData.error || `HTTP ${response.status}`}`)
      }

      // Reload to get updated status
      await loadSheets()
    } catch (err) {
      setStatusMessage(`Sync error: ${err instanceof Error ? err.message : String(err)}`)
      // Revert optimistic update
      await loadSheets()
    }
    setSyncingId(null)
  }

  const handleRemove = async (id: string) => {
    if (!window.confirm('Are you sure you want to remove this sheet sync? This cannot be undone.')) return
    setStatusMessage(null)
    try {
      const { error } = await supabase
        .from('google_sheets_sync')
        .delete()
        .eq('id', id)

      if (error) {
        setStatusMessage(`Failed to remove sheet: ${error.message}`)
        return
      }

      setSheets((prev) => prev.filter((s) => s.id !== id))
      setStatusMessage('Sheet removed.')
    } catch (err) {
      setStatusMessage(`Error removing sheet: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const openMappingModal = (sheet: GoogleSheetsSync) => {
    setSelectedSheet(sheet)
    setEditedMapping(sheet.column_mapping ? { ...sheet.column_mapping } : {})
  }

  const handleSaveMapping = async () => {
    if (!selectedSheet) return
    setSavingMapping(true)
    setStatusMessage(null)

    try {
      const { error } = await supabase
        .from('google_sheets_sync')
        .update({ column_mapping: editedMapping })
        .eq('id', selectedSheet.id)

      if (error) {
        setStatusMessage(`Failed to save mapping: ${error.message}`)
        setSavingMapping(false)
        return
      }

      setStatusMessage('Column mapping saved.')
      setSelectedSheet(null)
      await loadSheets()
    } catch (err) {
      setStatusMessage(`Error saving mapping: ${err instanceof Error ? err.message : String(err)}`)
    }
    setSavingMapping(false)
  }

  const updateMappingTarget = (source: string, newTarget: string) => {
    setEditedMapping((prev) => ({ ...prev, [source]: newTarget }))
  }

  const timeSince = (isoStr: string | null) => {
    if (!isoStr) return 'Never'
    const diff = Date.now() - new Date(isoStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'Just now'
    if (mins < 60) return `${mins} min ago`
    return `${Math.floor(mins / 60)}h ago`
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        <span className="ml-3 text-gray-500">Loading sheet configurations...</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Google Sheets Sync</h1>
          <p className="mt-1 text-sm text-gray-500">
            Connect and sync data from Google Sheets into the platform
          </p>
        </div>
        <Button onClick={() => setShowAddSheet(true)}>
          <Plus className="h-4 w-4" /> Add Sheet
        </Button>
      </div>

      {/* Status Message */}
      {statusMessage && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          {statusMessage}
        </div>
      )}

      {/* Connected sheets */}
      {sheets.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center justify-center py-12 text-gray-500">
            <FileSpreadsheet className="h-8 w-8 text-gray-300 mb-2" />
            <p className="font-medium text-gray-700">No sheets connected</p>
            <p className="text-sm mt-1">Click "Add Sheet" to connect your first Google Sheet.</p>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4">
          {sheets.map((sheet) => (
            <Card key={sheet.id}>
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-green-50 p-2">
                    <FileSpreadsheet className="h-6 w-6 text-green-600" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">{sheet.sheet_name}</h3>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        sheet.account_id ? 'bg-teal-50 text-teal-700' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {getAccountName(sheet.account_id)}
                      </span>
                    </div>
                    <a
                      href={sheet.sheet_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-teal-600 hover:underline"
                    >
                      Open in Google Sheets <ExternalLink className="h-3 w-3" />
                    </a>
                    <div className="mt-2 flex items-center gap-4 text-sm text-gray-500">
                      <span>Last sync: {timeSince(sheet.last_sync_at)}</span>
                      <span>{sheet.row_count.toLocaleString()} rows</span>
                      <span>{sheet.sync_schedule}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <SyncStatusBadge status={sheet.sync_status} />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleSyncNow(sheet.id)}
                    loading={syncingId === sheet.id}
                  >
                    <RefreshCw className="h-4 w-4" /> Sync Now
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openMappingModal(sheet)}
                  >
                    Configure Mapping
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemove(sheet.id)}
                  >
                    <Trash2 className="h-4 w-4 text-red-400" />
                  </Button>
                </div>
              </div>

              {/* Column mapping preview */}
              {sheet.column_mapping && (
                <div className="mt-4 rounded-lg border border-gray-100 bg-gray-50 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Column Mapping
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(sheet.column_mapping).map(([source, target]) => (
                      <div
                        key={source}
                        className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs"
                      >
                        <span className="font-medium text-gray-700">{source}</span>
                        <ArrowRight className="h-3 w-3 text-gray-400" />
                        <span className="text-teal-600">{target}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Add Sheet Modal */}
      <Modal
        open={showAddSheet}
        onClose={() => setShowAddSheet(false)}
        title="Add Google Sheet"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowAddSheet(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddSheet} disabled={!newSheetUrl} loading={addingSheet}>
              Add Sheet
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Google Sheet URL"
            placeholder="https://docs.google.com/spreadsheets/d/..."
            value={newSheetUrl}
            onChange={(e) => {
              setNewSheetUrl(e.target.value)
              if (e.target.value && !newSheetName) {
                setNewSheetName('Sheet1')
              }
            }}
          />
          <Input
            label="Sheet Tab Name(s)"
            value={newSheetName}
            onChange={(e) => setNewSheetName(e.target.value)}
            placeholder="e.g., Sheet1, Sheet2 (comma-separated for multiple tabs)"
          />
          {isAdmin ? (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Company *</label>
            <select
              value={newSheetAccountId}
              onChange={(e) => setNewSheetAccountId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="">General (Shared across all companies)</option>
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>{acc.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-400">
              AI will use this sheet&apos;s data when replying for the selected company.
            </p>
          </div>
          ) : null}
          <p className="text-xs text-gray-500">
            The sheet must be set to &quot;Anyone with the link can view&quot; for syncing to work.
          </p>
        </div>
      </Modal>

      {/* Column Mapping Modal */}
      <Modal
        open={!!selectedSheet}
        onClose={() => setSelectedSheet(null)}
        title={selectedSheet ? `Column Mapping - ${selectedSheet.sheet_name}` : ''}
        className="max-w-2xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSelectedSheet(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveMapping} loading={savingMapping}>
              Save Mapping
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            Map spreadsheet columns to database fields.
          </p>
          {Object.keys(editedMapping).length > 0 ? (
            Object.entries(editedMapping).map(([source, target]) => (
              <div
                key={source}
                className="flex items-center gap-3 rounded-lg border border-gray-200 p-3"
              >
                <GripVertical className="h-4 w-4 cursor-grab text-gray-400" />
                <div className="flex-1">
                  <Input value={source} readOnly />
                </div>
                <ArrowRight className="h-4 w-4 text-gray-400" />
                <div className="flex-1">
                  <select
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                    value={target}
                    onChange={(e) => updateMappingTarget(source, e.target.value)}
                  >
                    {availableColumns.map((col) => (
                      <option key={col} value={col}>
                        {col}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))
          ) : (
            <p className="py-4 text-center text-sm text-gray-500">
              No column mappings configured yet. Sync the sheet first to detect columns.
            </p>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const newSource = prompt('Enter the spreadsheet column name:')
              if (newSource) {
                setEditedMapping((prev) => ({ ...prev, [newSource]: 'external_id' }))
              }
            }}
          >
            <Plus className="h-4 w-4" /> Add Column Mapping
          </Button>
        </div>
      </Modal>
    </div>
  )
}
