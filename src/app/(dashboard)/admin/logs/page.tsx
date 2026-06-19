'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase-client'
import { useUser } from '@/context/user-context'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Pagination } from '@/components/ui/pagination'
import { Search, RefreshCw, AlertCircle, Info, AlertTriangle, Bug, Loader2, Trash2 } from 'lucide-react'
import { timeAgo } from '@/lib/utils'

interface LogEntry {
  id: string
  action: string
  details: string | null
  user_id: string | null
  account_id: string | null
  created_at: string
}

const PAGE_SIZE = 50

function parseLogLevel(action: string): 'info' | 'warn' | 'error' | 'debug' {
  if (action.startsWith('[ERROR]')) return 'error'
  if (action.startsWith('[WARN]')) return 'warn'
  if (action.startsWith('[DEBUG]')) return 'debug'
  return 'info'
}

function parseCategory(action: string): string {
  const match = action.match(/\]\s*(\w+):/)
  return match ? match[1] : 'system'
}

function LogLevelBadge({ level }: { level: string }) {
  switch (level) {
    case 'error': return <Badge variant="danger" size="sm"><AlertCircle className="h-3 w-3 mr-0.5" />Error</Badge>
    case 'warn': return <Badge variant="warning" size="sm"><AlertTriangle className="h-3 w-3 mr-0.5" />Warn</Badge>
    case 'debug': return <Badge variant="default" size="sm"><Bug className="h-3 w-3 mr-0.5" />Debug</Badge>
    default: return <Badge variant="info" size="sm"><Info className="h-3 w-3 mr-0.5" />Info</Badge>
  }
}

export default function LogsPage() {
  // Active-tenant scope. audit_log carries a denormalized company_id (added in
  // migration 20260504030000); restrict to it unless we're in super_admin
  // combined view (activeCompanyId === null → see every tenant's audit trail).
  const { activeCompanyId } = useUser()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [levelFilter, setLevelFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(false)

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()

    // Get total count
    let countQuery = supabase
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
    if (activeCompanyId) countQuery = countQuery.eq('company_id', activeCompanyId)
    if (search) countQuery = countQuery.ilike('action', `%${search}%`)
    if (levelFilter !== 'all') countQuery = countQuery.ilike('action', `%[${levelFilter.toUpperCase()}]%`)
    if (categoryFilter !== 'all') countQuery = countQuery.ilike('action', `%${categoryFilter}:%`)
    const { count } = await countQuery
    setTotalCount(count || 0)

    // Get paginated logs
    const offset = (page - 1) * PAGE_SIZE
    let query = supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)

    if (activeCompanyId) query = query.eq('company_id', activeCompanyId)
    if (search) query = query.ilike('action', `%${search}%`)
    if (levelFilter !== 'all') query = query.ilike('action', `%[${levelFilter.toUpperCase()}]%`)
    if (categoryFilter !== 'all') query = query.ilike('action', `%${categoryFilter}:%`)

    const { data } = await query
    setLogs((data || []) as LogEntry[])
    setLoading(false)
  }, [page, search, levelFilter, categoryFilter, activeCompanyId])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  // Auto-refresh every 10s
  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(fetchLogs, 10000)
    return () => clearInterval(timer)
  }, [autoRefresh, fetchLogs])

  const totalPages = Math.ceil(totalCount / PAGE_SIZE)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">System Logs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {totalCount} log entries — audit trail for all system actions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={autoRefresh ? 'primary' : 'secondary'}
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            <RefreshCw className={`h-4 w-4 ${autoRefresh ? 'animate-spin' : ''}`} />
            {autoRefresh ? 'Live' : 'Auto-refresh'}
          </Button>
          <Button size="sm" variant="secondary" onClick={fetchLogs}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[200px]">
            <Input
              placeholder="Search logs..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1) }}
              icon={<Search className="h-4 w-4" />}
            />
          </div>
          <Select
            value={levelFilter}
            onChange={(e) => { setLevelFilter(e.target.value); setPage(1) }}
            options={[
              { value: 'all', label: 'All Levels' },
              { value: 'info', label: 'Info' },
              { value: 'warn', label: 'Warning' },
              { value: 'error', label: 'Error' },
              { value: 'debug', label: 'Debug' },
            ]}
          />
          <Select
            value={categoryFilter}
            onChange={(e) => { setCategoryFilter(e.target.value); setPage(1) }}
            options={[
              { value: 'all', label: 'All Categories' },
              { value: 'webhook', label: 'Webhook' },
              { value: 'ai', label: 'AI' },
              { value: 'auth', label: 'Auth' },
              { value: 'system', label: 'System' },
              { value: 'notification', label: 'Notification' },
              { value: 'export', label: 'Export' },
            ]}
          />
        </div>
      </Card>

      {/* Log entries */}
      <Card>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
            <span className="ml-2 text-sm text-muted-foreground">Loading logs...</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
            <Trash2 className="h-10 w-10 mb-2" />
            <p className="font-medium">No log entries found</p>
            <p className="text-sm mt-1">Adjust your filters or check back later</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {logs.map((entry) => {
              const level = parseLogLevel(entry.action)
              const category = parseCategory(entry.action)
              let details: Record<string, unknown> = {}
              try { details = entry.details ? JSON.parse(entry.details) : {} } catch { /* ignore */ }
              const message = (details.message as string) || entry.action

              return (
                <div
                  key={entry.id}
                  className={`px-4 py-3 hover:bg-muted transition-colors ${
                    level === 'error' ? 'border-l-3 border-l-[var(--color-danger)] bg-[var(--color-danger)]/5' :
                    level === 'warn' ? 'border-l-3 border-l-[var(--color-warning)] bg-[var(--color-warning)]/5' : ''
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 mt-0.5">
                      <LogLevelBadge level={level} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-muted-foreground uppercase bg-muted rounded px-1.5 py-0.5">
                          {category}
                        </span>
                        <span className="text-sm text-foreground font-medium truncate">
                          {message}
                        </span>
                      </div>
                      {Object.keys(details).filter(k => k !== 'message' && k !== 'level' && k !== 'category').length > 0 && (
                        <pre className="mt-1 text-[11px] text-muted-foreground bg-muted rounded p-2 overflow-x-auto max-h-24">
                          {JSON.stringify(
                            Object.fromEntries(Object.entries(details).filter(([k]) => k !== 'message' && k !== 'level' && k !== 'category')),
                            null, 2
                          )}
                        </pre>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-zinc-500">{timeAgo(entry.created_at)}</p>
                      <p className="text-[10px] text-zinc-500">
                        {new Date(entry.created_at).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <Pagination
          currentPage={page}
          totalPages={totalPages}
          totalItems={totalCount}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </Card>
    </div>
  )
}
