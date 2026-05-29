'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Loader2, UserCircle, UserPlus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase-client'
import { useToast } from '@/components/ui/toast'
import { useUser } from '@/context/user-context'
import { isSupervisor } from '@/lib/roles'
// createClient still used to fetch the agent list — only the assignment write
// moved to the API route (so audit_log captures it for the timeline).

interface AgentUser {
  id: string
  full_name: string | null
  email: string
  role: string
  avatar_url: string | null
}

interface AgentAssignmentProps {
  conversationId: string
  currentAssignedTo: string | null
  currentAssignedName: string | null
  /**
   * Current viewer's auth user id. When set AND the viewer can't assign to
   * others (company_member), the component collapses to a single
   * "Assign to me" button instead of the full agent picker.
   */
  currentUserId?: string | null
}

export function AgentAssignment({
  conversationId,
  currentAssignedTo,
  currentAssignedName,
  currentUserId,
}: AgentAssignmentProps) {
  const { role: viewerRole, activeCompanyId } = useUser()
  // Phase 2 gate: only supervisor-or-above may reassign to ANOTHER user.
  // Members keep a self-claim affordance (Assign to me) so they can still
  // pick up unowned conversations.
  const canAssignOthers = isSupervisor(viewerRole)
  const router = useRouter()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [assignedTo, setAssignedTo] = useState<string | null>(currentAssignedTo)
  const [assignedName, setAssignedName] = useState<string | null>(currentAssignedName)
  const [users, setUsers] = useState<AgentUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

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

  // Fetch users when dropdown opens
  useEffect(() => {
    if (!open) return
    let cancelled = false

    async function fetchUsers() {
      setUsersLoading(true)
      try {
        const supabase = createClient()
        let usersQuery = supabase
          .from('users')
          .select('id, full_name, email, role, avatar_url')
          .eq('is_active', true)
          .order('full_name', { ascending: true })

        // Tenant scope: when a tenant is selected, only list that company's
        // users in the assignee dropdown. Combined view (super_admin,
        // activeCompanyId === null) lists everyone.
        if (activeCompanyId) usersQuery = usersQuery.eq('company_id', activeCompanyId)

        const { data, error } = await usersQuery

        if (cancelled) return
        if (error) throw error
        setUsers(data || [])
      } catch (err: any) {
        if (!cancelled) {
          console.error('Failed to fetch users:', err)
          setUsers([])
        }
      } finally {
        if (!cancelled) setUsersLoading(false)
      }
    }

    fetchUsers()
    return () => { cancelled = true }
  }, [open, activeCompanyId])

  const handleAssign = useCallback(async (userId: string | null) => {
    setLoading(true)
    setOpen(false)
    try {
      // Hits the dedicated API route (not direct supabase) so the change is
      // captured in audit_log → surfaces on the conversation activity timeline.
      const res = await fetch(`/api/conversations/${conversationId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload.error || `Request failed (${res.status})`)
      }

      setAssignedTo(userId)
      if (userId) {
        const user = users.find((u) => u.id === userId)
        setAssignedName(user?.full_name || user?.email || 'Unknown')
        toast.success(`Assigned to ${user?.full_name || user?.email}`)
      } else {
        setAssignedName(null)
        toast.success('Conversation unassigned')
      }
      router.refresh()
    } catch (err: any) {
      toast.error('Failed to assign: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [conversationId, users, router, toast])

  // ── Member view ────────────────────────────────────────────────────
  // Non-supervisors can't pick another agent. We render a compact badge
  // showing the current assignee (or "Unassigned") with an "Assign to me"
  // button when they're not already the assignee. No dropdown.
  if (!canAssignOthers) {
    const isMine = !!currentUserId && currentAssignedTo === currentUserId
    const assignToMe = () => { void handleAssign(currentUserId ?? null) }
    return (
      <div className="flex items-center gap-1.5">
        {assignedTo ? (
          <Badge variant={isMine ? 'success' : 'info'} size="sm">
            {loading ? (
              <Loader2 size={10} className="animate-spin mr-1" />
            ) : (
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white mr-1">
                {getInitials(assignedName, '')}
              </span>
            )}
            {isMine ? 'Assigned to you' : assignedName || 'Assigned'}
          </Badge>
        ) : (
          <Badge variant="default" size="sm">
            <UserCircle size={12} className="mr-0.5 text-gray-400" />
            Unassigned
          </Badge>
        )}
        {!isMine && currentUserId && (
          <button
            type="button"
            onClick={assignToMe}
            disabled={loading}
            title="Assign this conversation to yourself"
            className="inline-flex items-center gap-1 rounded-full bg-teal-50 border border-teal-200 px-2 py-0.5 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 disabled:opacity-50"
          >
            {loading ? <Loader2 size={10} className="animate-spin" /> : <UserPlus size={11} />}
            Assign to me
          </button>
        )}
      </div>
    )
  }

  function getInitials(name: string | null, email: string): string {
    if (name) {
      return name
        .split(' ')
        .filter(Boolean)
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2) || '?'
    }
    return email && email.length > 0 ? email[0].toUpperCase() : '?'
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-full transition-colors hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-1"
      >
        {assignedTo ? (
          <Badge variant="info" size="sm">
            {loading ? (
              <Loader2 size={10} className="animate-spin mr-1" />
            ) : (
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white mr-1">
                {getInitials(assignedName, '')}
              </span>
            )}
            {assignedName || 'Assigned'}
            <ChevronDown size={10} className="ml-0.5" />
          </Badge>
        ) : (
          <Badge variant="default" size="sm">
            {loading ? (
              <Loader2 size={10} className="animate-spin mr-1" />
            ) : (
              <UserCircle size={12} className="mr-0.5 text-gray-400" />
            )}
            Unassigned
            <ChevronDown size={10} className="ml-0.5" />
          </Badge>
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 rounded-lg border border-gray-200 bg-white shadow-lg z-30 py-1">
          <div className="px-3 py-1.5 border-b border-gray-100">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Assign to</p>
          </div>

          {/* Unassign option */}
          {assignedTo && (
            <button
              onClick={() => handleAssign(null)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors border-b border-gray-100"
            >
              <X size={14} />
              Unassign
            </button>
          )}

          {usersLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={18} className="animate-spin text-gray-400" />
            </div>
          ) : users.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-gray-400">
              No users found
            </div>
          ) : (
            <div className="max-h-52 overflow-y-auto py-1">
              {users.map((user) => (
                <button
                  key={user.id}
                  onClick={() => handleAssign(user.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                    user.id === assignedTo
                      ? 'bg-teal-50 text-teal-700 font-medium'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-[10px] font-bold text-gray-600 shrink-0">
                    {getInitials(user.full_name, user.email)}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {user.full_name || user.email}
                    </p>
                    {user.full_name && (
                      <p className="text-xs text-gray-400 truncate">{user.email}</p>
                    )}
                  </div>
                  {user.id === assignedTo && (
                    <span className="ml-auto text-xs text-teal-500 shrink-0">Current</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
