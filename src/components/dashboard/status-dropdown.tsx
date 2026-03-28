'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase-client'
import { useToast } from '@/components/ui/toast'
import type { ConversationStatus } from '@/types/database'

interface StatusDropdownProps {
  conversationId: string
  currentStatus: ConversationStatus
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

export function StatusDropdown({ conversationId, currentStatus }: StatusDropdownProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<ConversationStatus>(currentStatus)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Sync local state when parent prop changes
  useEffect(() => { setStatus(currentStatus) }, [currentStatus])

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

  const config = statusConfig[status]

  return (
    <div className="relative" ref={dropdownRef}>
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

      {open && (
        <div className="absolute top-full left-0 mt-1 w-52 rounded-lg border border-gray-200 bg-white shadow-lg z-30 py-1">
          <div className="px-3 py-1.5 border-b border-gray-100">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Change Status</p>
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
        </div>
      )}
    </div>
  )
}
