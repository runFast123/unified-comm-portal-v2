'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase-client'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Modal } from '@/components/ui/modal'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import type { User, UserRole } from '@/types/database'
import { timeAgo } from '@/lib/utils'
import {
  Users,
  UserPlus,
  Shield,
  Eye,
  Edit2,
  Pencil,
  Mail,
  Loader2,
  AlertCircle,
  Building2,
  Search,
  UserX,
  Check,
  UserCheck,
} from 'lucide-react'

interface Account {
  id: string
  name: string
}

function getRoleBadge(role: UserRole) {
  switch (role) {
    case 'admin':
      return (
        <Badge variant="danger">
          <Shield className="mr-1 h-3 w-3" /> Admin
        </Badge>
      )
    case 'reviewer':
      return (
        <Badge variant="info">
          <Edit2 className="mr-1 h-3 w-3" /> Reviewer
        </Badge>
      )
    case 'viewer':
      return (
        <Badge variant="default">
          <Eye className="mr-1 h-3 w-3" /> Viewer
        </Badge>
      )
  }
}

function getInitials(name: string | null) {
  if (!name) return '??'
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

const ROLE_OPTIONS = [
  { value: '', label: 'All Roles' },
  { value: 'admin', label: 'Admin' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'viewer', label: 'Viewer' },
]

const STATUS_OPTIONS = [
  { value: '', label: 'All Status' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
]

export default function UsersPage() {
  const supabase = createClient()
  const [users, setUsers] = useState<User[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountMap, setAccountMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Search & filter
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  // Invite modal
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState<UserRole>('viewer')
  const [inviteAccountId, setInviteAccountId] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  // Edit modal
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editUser, setEditUser] = useState<User | null>(null)
  const [editName, setEditName] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [editRole, setEditRole] = useState<UserRole>('viewer')
  const [editAccountId, setEditAccountId] = useState('')
  const [editIsActive, setEditIsActive] = useState(true)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  // Deactivate confirmation
  const [deactivateUser, setDeactivateUser] = useState<User | null>(null)
  const [deactivating, setDeactivating] = useState(false)

  // Toast
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3500)
      return () => clearTimeout(timer)
    }
  }, [toast])

  // Fetch users and accounts from Supabase
  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)

    const [usersResult, accountsResult] = await Promise.allSettled([
      supabase
        .from('users')
        .select('*')
        .order('created_at', { ascending: true }),
      supabase
        .from('accounts')
        .select('id, name')
        .order('name'),
    ])

    // Handle users result
    if (usersResult.status === 'fulfilled' && !usersResult.value.error) {
      setUsers((usersResult.value.data as User[]) ?? [])
    } else {
      const errorMsg = usersResult.status === 'rejected'
        ? usersResult.reason?.message || 'Failed to fetch users'
        : usersResult.value.error?.message || 'Failed to fetch users'
      setError(errorMsg)
      setUsers([])
    }

    // Handle accounts result independently
    if (accountsResult.status === 'fulfilled' && !accountsResult.value.error) {
      const accts = (accountsResult.value.data as Account[]) ?? []
      const map: Record<string, string> = {}
      for (const a of accts) {
        map[a.id] = a.name
      }
      setAccounts(accts)
      setAccountMap(map)
    } else {
      console.error('Failed to fetch accounts:', accountsResult.status === 'rejected' ? accountsResult.reason : accountsResult.value.error)
      setAccounts([])
      setAccountMap({})
    }

    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [])

  // Filtered users
  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      const matchesSearch =
        !searchQuery ||
        (u.full_name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        u.email.toLowerCase().includes(searchQuery.toLowerCase())
      const matchesRole = !roleFilter || u.role === roleFilter
      const matchesStatus =
        !statusFilter ||
        (statusFilter === 'active' ? u.is_active : !u.is_active)
      return matchesSearch && matchesRole && matchesStatus
    })
  }, [users, searchQuery, roleFilter, statusFilter])

  // Stats
  const activeCount = users.filter((u) => u.is_active).length
  const adminCount = users.filter((u) => u.role === 'admin').length
  const reviewerCount = users.filter((u) => u.role === 'reviewer').length

  // Invite handler
  const handleInvite = useCallback(async () => {
    if (!inviteEmail) return
    setInviting(true)
    setInviteError(null)

    const newUser = {
      email: inviteEmail.trim().toLowerCase(),
      full_name: inviteName.trim() || null,
      role: inviteRole,
      avatar_url: null,
      is_active: true,
      last_login_at: null,
      account_id: inviteAccountId || null,
    }

    const { data, error: insertError } = await supabase
      .from('users')
      .insert(newUser)
      .select()
      .single()

    if (insertError) {
      setInviteError(insertError.message)
      setInviting(false)
      return
    }

    setUsers((prev) => [...prev, data as User])
    setInviteEmail('')
    setInviteName('')
    setInviteRole('viewer')
    setInviteAccountId('')
    setInviteError(null)
    setShowInvite(false)
    setInviting(false)
    setToast({ type: 'success', message: `User ${inviteEmail} pre-registered successfully` })
  }, [inviteEmail, inviteName, inviteRole, inviteAccountId, supabase])

  // Open edit modal
  function handleOpenEdit(user: User) {
    setEditUser(user)
    setEditName(user.full_name ?? '')
    setEditEmail(user.email)
    setEditRole(user.role)
    setEditAccountId(user.account_id ?? '')
    setEditIsActive(user.is_active)
    setEditError(null)
    setEditModalOpen(true)
  }

  // Save edit
  const handleSaveEdit = useCallback(async () => {
    if (!editUser) return
    setEditSaving(true)
    setEditError(null)

    const updates = {
      full_name: editName.trim() || null,
      email: editEmail.trim().toLowerCase(),
      role: editRole as UserRole,
      account_id: editAccountId || null,
      is_active: editIsActive,
    }

    const { error: updateError } = await supabase
      .from('users')
      .update(updates)
      .eq('id', editUser.id)

    if (updateError) {
      setEditError(updateError.message)
      setEditSaving(false)
      return
    }

    setUsers((prev) =>
      prev.map((u) =>
        u.id === editUser.id ? { ...u, ...updates } : u
      )
    )
    setEditSaving(false)
    setEditModalOpen(false)
    setEditUser(null)
    setToast({ type: 'success', message: 'User updated successfully' })
  }, [editUser, editName, editEmail, editRole, editAccountId, editIsActive, supabase])

  // Deactivate handler
  const handleDeactivate = useCallback(async () => {
    if (!deactivateUser) return
    setDeactivating(true)

    const { error: updateError } = await supabase
      .from('users')
      .update({ is_active: false })
      .eq('id', deactivateUser.id)

    if (updateError) {
      setToast({ type: 'error', message: `Failed to deactivate: ${updateError.message}` })
      setDeactivating(false)
      return
    }

    setUsers((prev) =>
      prev.map((u) =>
        u.id === deactivateUser.id ? { ...u, is_active: false } : u
      )
    )
    setToast({ type: 'success', message: `${deactivateUser.full_name || deactivateUser.email} has been deactivated` })
    setDeactivateUser(null)
    setDeactivating(false)
  }, [deactivateUser, supabase])

  // Reactivate handler
  const handleReactivate = useCallback(async (user: User) => {
    const { error: updateError } = await supabase
      .from('users')
      .update({ is_active: true })
      .eq('id', user.id)

    if (updateError) {
      setToast({ type: 'error', message: `Failed to reactivate: ${updateError.message}` })
      return
    }

    setUsers((prev) =>
      prev.map((u) =>
        u.id === user.id ? { ...u, is_active: true } : u
      )
    )
    setToast({ type: 'success', message: `${user.full_name || user.email} has been reactivated` })
  }, [supabase])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        <span className="ml-3 text-gray-500">Loading users...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <p className="text-red-600 font-medium">Failed to load users</p>
        <p className="text-sm text-gray-500 mt-1">{error}</p>
        <Button variant="secondary" className="mt-4" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage portal users, roles, and access permissions
          </p>
        </div>
        <Button onClick={() => setShowInvite(true)}>
          <UserPlus className="h-4 w-4" /> Add User
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 text-gray-600">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Total Users</p>
              <p className="text-2xl font-bold text-gray-900">{users.length}</p>
            </div>
          </div>
        </Card>
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100 text-green-600">
              <UserCheck className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Active Users</p>
              <p className="text-2xl font-bold text-gray-900">{activeCount}</p>
            </div>
          </div>
        </Card>
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-100 text-red-600">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Admins</p>
              <p className="text-2xl font-bold text-gray-900">{adminCount}</p>
            </div>
          </div>
        </Card>
        <Card className="!py-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-blue-600">
              <Edit2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Reviewers</p>
              <p className="text-2xl font-bold text-gray-900">{reviewerCount}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Search and filter bar */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <Input
            placeholder="Search by name or email..."
            icon={<Search className="h-4 w-4" />}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-40">
          <Select
            options={ROLE_OPTIONS}
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-40">
          <Select
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          />
        </div>
      </div>

      {/* Users table */}
      <Card>
        {filteredUsers.length === 0 ? (
          <EmptyState
            icon={<Users className="h-12 w-12" />}
            title="No users found"
            description={
              users.length === 0
                ? 'No users have been added yet. Invite your first user to get started.'
                : 'Try adjusting your search or filter criteria.'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Full Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredUsers.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-100 text-sm font-semibold text-teal-700">
                        {getInitials(user.full_name)}
                      </div>
                      <span className="font-medium text-gray-900">
                        {user.full_name || 'Unknown'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 text-sm text-gray-600">
                      <Mail className="h-3.5 w-3.5" />
                      {user.email}
                    </div>
                  </TableCell>
                  <TableCell>{getRoleBadge(user.role)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 text-sm text-gray-600">
                      <Building2 className="h-3.5 w-3.5 text-gray-400" />
                      {user.account_id
                        ? accountMap[user.account_id] || 'Unknown'
                        : <span className="text-gray-400 italic">None (Admin)</span>
                      }
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.is_active ? 'success' : 'default'}>
                      {user.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-gray-500">
                      {timeAgo(user.created_at)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleOpenEdit(user)}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                        title="Edit user"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      {user.is_active ? (
                        <button
                          onClick={() => setDeactivateUser(user)}
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                          title="Deactivate user"
                        >
                          <UserX className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleReactivate(user)}
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-green-50 hover:text-green-600 transition-colors"
                          title="Reactivate user"
                        >
                          <UserCheck className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Invite User Modal */}
      <Modal
        open={showInvite}
        onClose={() => { setShowInvite(false); setInviteError(null) }}
        title="Add User"
        footer={
          <>
            <Button variant="secondary" onClick={() => { setShowInvite(false); setInviteError(null) }}>
              Cancel
            </Button>
            <Button onClick={handleInvite} disabled={!inviteEmail || inviting} loading={inviting}>
              <UserPlus className="h-4 w-4" />
              {inviting ? 'Adding...' : 'Add User'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {inviteError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 text-red-600" />
              <p className="text-sm text-red-700">{inviteError}</p>
            </div>
          )}
          <Input
            label="Full Name"
            value={inviteName}
            onChange={(e) => setInviteName(e.target.value)}
            placeholder="John Doe"
          />
          <Input
            label="Email Address"
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="user@company.com"
            icon={<Mail className="h-4 w-4" />}
          />
          <Select
            label="Role"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as UserRole)}
            options={[
              { value: 'admin', label: 'Admin - Full access to all settings' },
              { value: 'reviewer', label: 'Reviewer - Can review and approve AI replies' },
              { value: 'viewer', label: 'Viewer - Read-only access to dashboard' },
            ]}
          />
          <Select
            label="Company"
            value={inviteAccountId}
            onChange={(e) => setInviteAccountId(e.target.value)}
            options={[
              { value: '', label: 'None (for admins with access to all)' },
              ...accounts.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="text-xs text-gray-500">
              This pre-registers the user with their role and company assignment.
              When they sign up via the login page with the same email, they will
              automatically inherit these settings.
            </p>
          </div>
        </div>
      </Modal>

      {/* Edit User Modal */}
      <Modal
        open={editModalOpen}
        onClose={() => { setEditModalOpen(false); setEditUser(null); setEditError(null) }}
        title="Edit User"
        footer={
          <>
            <Button variant="secondary" onClick={() => { setEditModalOpen(false); setEditUser(null); setEditError(null) }}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={!editEmail || editSaving} loading={editSaving}>
              <Check className="h-4 w-4" />
              {editSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {editError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 text-red-600" />
              <p className="text-sm text-red-700">{editError}</p>
            </div>
          )}
          <Input
            label="Full Name"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="John Doe"
          />
          <Input
            label="Email Address"
            type="email"
            value={editEmail}
            onChange={(e) => setEditEmail(e.target.value)}
            placeholder="user@company.com"
            icon={<Mail className="h-4 w-4" />}
          />
          <Select
            label="Role"
            value={editRole}
            onChange={(e) => setEditRole(e.target.value as UserRole)}
            options={[
              { value: 'admin', label: 'Admin - Full access to all settings' },
              { value: 'reviewer', label: 'Reviewer - Can review and approve AI replies' },
              { value: 'viewer', label: 'Viewer - Read-only access to dashboard' },
            ]}
          />
          <Select
            label="Company"
            value={editAccountId}
            onChange={(e) => setEditAccountId(e.target.value)}
            options={[
              { value: '', label: 'None (for admins with access to all)' },
              ...accounts.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setEditIsActive(true)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  editIsActive
                    ? 'border-green-500 bg-green-50 text-green-700'
                    : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                Active
              </button>
              <button
                type="button"
                onClick={() => setEditIsActive(false)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  !editIsActive
                    ? 'border-red-500 bg-red-50 text-red-700'
                    : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                Inactive
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Deactivate Confirmation Modal */}
      <Modal
        open={!!deactivateUser}
        onClose={() => setDeactivateUser(null)}
        title="Deactivate User"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeactivateUser(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDeactivate} loading={deactivating}>
              <UserX className="h-4 w-4" />
              {deactivating ? 'Deactivating...' : 'Deactivate'}
            </Button>
          </>
        }
      >
        {deactivateUser && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
                <UserX className="h-5 w-5 text-red-600" />
              </div>
              <div>
                <p className="font-medium text-gray-900">
                  {deactivateUser.full_name || deactivateUser.email}
                </p>
                <p className="text-sm text-gray-500">{deactivateUser.email}</p>
              </div>
            </div>
            <p className="text-sm text-gray-600">
              Are you sure you want to deactivate this user? They will no longer be able to
              access the portal. This action can be reversed by reactivating the user later.
            </p>
          </div>
        )}
      </Modal>

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] animate-in slide-in-from-bottom-4 fade-in duration-300">
          <div
            className={`flex items-center gap-2 rounded-lg px-4 py-3 shadow-lg text-sm font-medium ${
              toast.type === 'success'
                ? 'bg-green-600 text-white'
                : 'bg-red-600 text-white'
            }`}
          >
            {toast.type === 'success' ? (
              <Check className="h-4 w-4" />
            ) : (
              <AlertCircle className="h-4 w-4" />
            )}
            {toast.message}
          </div>
        </div>
      )}
    </div>
  )
}
