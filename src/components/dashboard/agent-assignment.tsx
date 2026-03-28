'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Loader2, UserCircle, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase-client'
import { useToast } from '@/components/ui/toast'

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
}

export function AgentAssignment({
  conversationId,
  currentAssignedTo,
  currentAssignedName,
}: AgentAssignmentProps) {
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
        const { data, error } = await supabase
          .from('users')
          .select('id, full_name, email, role, avatar_url')
          .eq('is_active', true)
          .order('full_name', { ascending: true })

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
  }, [open])

  const handleAssign = useCallback(async (userId: string | null) => {
    setLoading(true)
    setOpen(false)
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from('conversations')
        .update({ assigned_to: userId })
        .eq('id', conversationId)
      if (error) throw error

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

  function getInitials(name: string | null, email: string): string {
    if (name) {
      return name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    }
    return email[0].toUpperCase()
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
