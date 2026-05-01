'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Loader2, Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase-client'
import { useToast } from '@/components/ui/toast'
import type { ConversationStatus } from '@/types/database'

interface CustomStatus {
  id: string
  name: string
  color: string
}

interface StatusDropdownProps {
  conversationId: string
  currentStatus: ConversationStatus
  /** Optional company-defined sub-status (free-text from the catalog). */
  secondaryStatus?: string | null
  /** Color saved alongside the secondary status — used for the dot. */
  secondaryStatusColor?: string | null
}

const statusConfig: Record<ConversationStatus, { label: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'default'; color: string }> = {
  active: { label: 'Active', variant: 'warning', color: 'bg-yellow-500' },
  in_progress: { label: 'In Progress', variant: 'info', color: 'bg-blue-500' },
  waiting_on_customer: { label: 'Waiting on Customer', variant: 'default', color: 'bg-amber-400' },
  resolved: { label: 'Resolved', variant: 'success', color: 'bg-green-500' },
  escalated: { label: 'Escalated', variant: 'danger', color: 'bg-red-500' },
  archived: { label: 'Archived', variant: 'default', color: 'bg-gray-400' },
}

const statusOrder: ConversationStatus[] = [
  'active',
  'in_progress',
  'waiting_on_customer',
  'escalated',
  'resolved',
  'archived',
]

export function StatusDropdown({
  conversationId,
  currentStatus,
  secondaryStatus = null,
  secondaryStatusColor = null,
}: StatusDropdownProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<ConversationStatus>(currentStatus)
  const [secondary, setSecondary] = useState<string | null>(secondaryStatus)
  const [secondaryColor, setSecondaryColor] = useState<string | null>(secondaryStatusColor)
  const [customStatuses, setCustomStatuses] = useState<CustomStatus[]>([])
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Sync local state when parent prop changes
  useEffect(() => { setStatus(currentStatus) }, [currentStatus])
  useEffect(() => { setSecondary(secondaryStatus) }, [secondaryStatus])
  useEffect(() => { setSecondaryColor(secondaryStatusColor) }, [secondaryStatusColor])

  // Lazy-load company custom statuses the first time the menu opens, so
  // closed dropdowns don't churn on the network.
  useEffect(() => {
    if (!open || customStatuses.length > 0) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/company-statuses')
        if (!res.ok) return
        const json = (await res.json()) as { statuses?: CustomStatus[] }
        if (!cancelled) setCustomStatuses(json.statuses ?? [])
      } catch {
        /* silent — custom section just won't render */
      }
    })()
    return () => { cancelled = true }
  }, [open, customStatuses.length])

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleStatusChange = useCallback(async (newStatus: ConversationStatus) => {
    if (newStatus === status) {
      setOpen(false)
      return
    }
    setLoading(true)
    setOpen(false)
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from('conversations')
        .update({ status: newStatus })
        .eq('id', conversationId)
      if (error) throw error
      setStatus(newStatus)
      toast.success(`Status changed to ${statusConfig[newStatus].label}`)
      router.refresh()
    } catch (err: any) {
      toast.error('Failed to update status: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [conversationId, status, router, toast])

  // Toggle / set the company-defined secondary status. Selecting the current
  // value clears it (acts as a "remove sub-status" toggle).
  const handleSecondaryChange = useCallback(async (next: CustomStatus | null) => {
    setLoading(true)
    setOpen(false)
    try {
      const supabase = createClient()
      const payload = next
        ? { secondary_status: next.name, secondary_status_color: next.color }
        : { secondary_status: null, secondary_status_color: null }
      const { error } = await supabase
        .from('conversations')
        .update(payload)
        .eq('id', conversationId)
      if (error) throw error
      setSecondary(next?.name ?? null)
      setSecondaryColor(next?.color ?? null)
      toast.success(next ? `Sub-status: ${next.name}` : 'Sub-status cleared')
      router.refresh()
    } catch (err: any) {
      toast.error('Failed to update sub-status: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [conversationId, router, toast])

  const config = statusConfig[status]

  return (
    <div className="relative inline-flex items-center gap-1.5" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        disabled={loading}
        className="inline-flex items-center gap-1 rounded-full transition-colors hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-1"
      >
        <Badge variant={config.variant} size="sm">
          {loading ? (
            <Loader2 size={10} className="animate-spin mr-1" />
          ) : (
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${config.color} mr-1`} />
          )}
          {config.label}
          <ChevronDown size={10} className="ml-0.5" />
        </Badge>
      </button>

      {/* Secondary-status pill — surfaced next to the lifecycle pill so users
          can tell at a glance that a custom sub-status is set. */}
      {secondary && (
        <span
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border"
          style={{
            background: hexToBgSoft(secondaryColor || '#6b7280'),
            borderColor: secondaryColor || '#6b7280',
            color: secondaryColor || '#374151',
          }}
          title={`Custom status: ${secondary}`}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: secondaryColor || '#6b7280' }}
          />
          {secondary}
        </span>
      )}

      {open && (
        <div className="absolute top-full left-0 mt-1 w-60 rounded-lg border border-gray-200 bg-white shadow-lg z-30 py-1 max-h-96 overflow-y-auto">
          <div className="px-3 py-1.5 border-b border-gray-100">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Lifecycle</p>
          </div>
          {statusOrder.map((s) => {
            const sc = statusConfig[s]
            return (
              <button
                key={s}
                onClick={() => handleStatusChange(s)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                  s === status
                    ? 'bg-teal-50 text-teal-700 font-medium'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span className={`inline-block h-2 w-2 rounded-full ${sc.color}`} />
                {sc.label}
                {s === status && (
                  <span className="ml-auto text-xs text-teal-500">Current</span>
                )}
              </button>
            )
          })}

          {/* Custom sub-statuses (per-company catalog). Only renders when the
              company has at least one defined; otherwise the menu just shows
              the lifecycle list. */}
          {customStatuses.length > 0 && (
            <>
              <div className="mt-1 px-3 py-1.5 border-y border-gray-100 bg-gray-50/60 flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Custom</p>
                {secondary && (
                  <button
                    onClick={() => handleSecondaryChange(null)}
                    className="text-[10px] text-gray-500 hover:text-red-600"
                  >
                    Clear
                  </button>
                )}
              </div>
              {customStatuses.map((cs) => {
                const isActive = secondary === cs.name
                return (
                  <button
                    key={cs.id}
                    onClick={() => handleSecondaryChange(isActive ? null : cs)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                      isActive ? 'bg-teal-50 text-teal-700 font-medium' : 'text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-full border border-black/10"
                      style={{ background: cs.color }}
                    />
                    {cs.name}
                    {isActive && <Check size={12} className="ml-auto text-teal-500" />}
                  </button>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Soft 18% background derived from a hex/named color. Falls back to a neutral
// gray if the value isn't parseable as #RRGGBB / #RGB. This is intentionally
// duplicated from the taxonomy admin page — keeping the helper local avoids
// a shared util that would only ever serve these two files.
function hexToBgSoft(color: string): string {
  if (color.startsWith('#')) {
    const c = color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color
    const r = parseInt(c.slice(1, 3), 16)
    const g = parseInt(c.slice(3, 5), 16)
    const b = parseInt(c.slice(5, 7), 16)
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return `rgba(${r}, ${g}, ${b}, 0.12)`
    }
  }
  return 'rgba(107, 114, 128, 0.12)'
}
