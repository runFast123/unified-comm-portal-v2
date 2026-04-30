'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase-client'
import { Card } from '@/components/ui/card'
import { KPICard } from '@/components/dashboard/kpi-card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import { Modal } from '@/components/ui/modal'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/toast'
import type { User, UserRole } from '@/types/database'
import { timeAgo } from '@/lib/utils'
import {
  Users,
  UserPlus,
  Shield,
  Eye,
  Edit2,
  Mail,
  Loader2,
  AlertCircle,
  Search,
  Check,
  UserCheck,
  Info,
  Save,
} from 'lucide-react'

interface Account {
  id: string
  name: string
  is_active?: boolean
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

const ROLE_EDIT_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'viewer', label: 'Viewer' },
]

interface RowDraft {
  role: UserRole
  account_id: string // '' means no account
  is_active: boolean
}

function isDirty(u: User, draft: RowDraft): boolean {
  return (
    draft.role !== u.role ||
    (draft.account_id || null) !== (u.account_id || null) ||
    draft.is_active !== u.is_active
  )
}

export default function UsersPage() {
  const supabase = createClient()
  const { toast } = useToast()

  const [users, setUsers] = useState<User[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountMap, setAccountMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Per-row pending edits, keyed by user id
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  // Search & filter
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  // Invite modal (kept from prior implementation — pre-registration flow)
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState<UserRole>('viewer')
  const [inviteAccountId, setInviteAccountId] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

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
        .select('id, name, is_active')
        .order('name'),
    ])

    if (usersResult.status === 'fulfilled' && !usersResult.value.error) {
      const fetched = (usersResult.value.data as User[]) ?? []
      setUsers(fetched)
      // Seed drafts so inline controls have stable state
      const seed: Record<string, RowDraft> = {}
      for (const u of fetched) {
        seed[u.id] = {
          role: u.role,
          account_id: u.account_id ?? '',
          is_active: u.is_active,
        }
      }
      setDrafts(seed)
    } else {
      const errorMsg = usersResult.status === 'rejected'
        ? usersResult.reason?.message || 'Failed to fetch users'
        : usersResult.value.error?.message || 'Failed to fetch users'
      setError(errorMsg)
      setUsers([])
    }

    if (accountsResult.status === 'fulfilled' && !accountsResult.value.error) {
      const accts = (accountsResult.value.data as Account[]) ?? []
      const map: Record<string, string> = {}
      for (const a of accts) map[a.id] = a.name
      setAccounts(accts)
      setAccountMap(map)
    } else {
      console.error(
        'Failed to fetch accounts:',
        accountsResult.status === 'rejected' ? accountsResult.reason : accountsResult.value.error
      )
      setAccounts([])
      setAccountMap({})
    }

    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

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
  const viewersWithoutAccount = users.filter(
    (u) => u.role === 'viewer' && !u.account_id
  ).length

  // Account options for the inline dropdown (active accounts + no-account)
  const accountDropdownOptions = useMemo(
    () => [
      { value: '', label: '— No account —' },
      ...accounts
        .filter((a) => a.is_active !== false)
        .map((a) => ({ value: a.id, label: a.name })),
    ],
    [accounts]
  )

  // Update a single field in a row's draft
  const updateDraft = useCallback(
    (userId: string, patch: Partial<RowDraft>) => {
      setDrafts((prev) => ({
        ...prev,
        [userId]: { ...prev[userId], ...patch },
      }))
    },
    []
  )

  // Save a row via the admin API
  const saveRow = useCallback(
    async (user: User) => {
      const draft = drafts[user.id]
      if (!draft) return
      if (!isDirty(user, draft)) return

      setSavingId(user.id)

      // Build patch of only changed fields
      const body: {
        user_id: string
        role?: UserRole
        account_id?: string | null
        is_active?: boolean
      } = { user_id: user.id }

      if (draft.role !== user.role) body.role = draft.role
      if ((draft.account_id || null) !== (user.account_id || null)) {
        body.account_id = draft.account_id || null
      }
      if (draft.is_active !== user.is_active) body.is_active = draft.is_active

      try {
        const res = await fetch('/api/users/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json()
        if (!res.ok) {
          toast.error(data?.error || 'Failed to update user')
          setSavingId(null)
          return
        }

        // Merge returned user into list
        setUsers((prev) =>
          prev.map((u) => (u.id === user.id ? ({ ...u, ...data.user } as User) : u))
        )
        // Reset draft to saved state
        setDrafts((prev) => ({
          ...prev,
          [user.id]: {
            role: data.user.role,
            account_id: data.user.account_id ?? '',
            is_active: data.user.is_active,
          },
        }))
        toast.success(`Updated ${user.email}`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update user')
      } finally {
        setSavingId(null)
      }
    },
    [drafts, toast]
  )

  // Invite handler (existing pre-registration flow — unchanged, direct insert)
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

    const inserted = data as User
    setUsers((prev) => [...prev, inserted])
    setDrafts((prev) => ({
      ...prev,
      [inserted.id]: {
        role: inserted.role,
        account_id: inserted.account_id ?? '',
        is_active: inserted.is_active,
      },
    }))
    setInviteEmail('')
    setInviteName('')
    setInviteRole('viewer')
    setInviteAccountId('')
    setInviteError(null)
    setShowInvite(false)
    setInviting(false)
    toast.success(`User ${inviteEmail} pre-registered successfully`)
  }, [inviteEmail, inviteName, inviteRole, inviteAccountId, supabase, toast])

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
            Manage portal users, roles, and account assignments
          </p>
        </div>
        <Button onClick={() => setShowInvite(true)}>
          <UserPlus className="h-4 w-4" /> Add User
        </Button>
      </div>

      {/* Hint banner */}
      <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div className="text-sm text-amber-900">
          <p className="font-medium">Viewers with no assigned account can&apos;t send or trigger syncs.</p>
          <p className="mt-0.5 text-amber-800">
            Assign an account to activate their access.
            {viewersWithoutAccount > 0 && (
              <>
                {' '}
                <span className="font-semibold">
                  {viewersWithoutAccount} user{viewersWithoutAccount === 1 ? '' : 's'} currently
                  need{viewersWithoutAccount === 1 ? 's' : ''} an account.
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          title="Total Users"
          value={users.length}
          icon={Users}
          color="gray"
          subtitle={users.length === 1 ? '1 account' : `${users.length} accounts`}
        />
        <KPICard
          title="Active Users"
          value={activeCount}
          icon={UserCheck}
          color="green"
          subtitle={users.length > 0 ? `${Math.round((activeCount / users.length) * 100)}% of total` : undefined}
        />
        <KPICard
          title="Admins"
          value={adminCount}
          icon={Shield}
          color="red"
          subtitle="Full access"
        />
        <KPICard
          title="Viewers Missing Account"
          value={viewersWithoutAccount}
          icon={AlertCircle}
          color="amber"
          alert={viewersWithoutAccount > 0}
          subtitle={viewersWithoutAccount === 0 ? 'All assigned' : 'Locked out — assign account'}
        />
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
                <TableHead>Email</TableHead>
                <TableHead className="hidden lg:table-cell">Full Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="hidden md:table-cell">Account</TableHead>
                <TableHead className="hidden sm:table-cell">Active</TableHead>
                <TableHead className="hidden xl:table-cell">Last Login</TableHead>
                <TableHead className="hidden xl:table-cell">Created</TableHead>
                <TableHead className="text-right">Save</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredUsers.map((user) => {
                const draft = drafts[user.id] ?? {
                  role: user.role,
                  account_id: user.account_id ?? '',
                  is_active: user.is_active,
                }
                const dirty = isDirty(user, draft)
                const saving = savingId === user.id
                const missingAccount =
                  draft.role === 'viewer' && !draft.account_id && draft.is_active

                // If current account isn't in the active list (e.g. soft-deleted), still show it
                const selectOptions = (() => {
                  const exists = accountDropdownOptions.some(
                    (o) => o.value === draft.account_id
                  )
                  if (draft.account_id && !exists) {
                    return [
                      ...accountDropdownOptions,
                      {
                        value: draft.account_id,
                        label: `${accountMap[draft.account_id] ?? 'Unknown'} (inactive)`,
                      },
                    ]
                  }
                  return accountDropdownOptions
                })()

                return (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-sm text-gray-600">
                        <Mail className="h-3.5 w-3.5 text-gray-400" />
                        <span className="font-medium text-gray-900">{user.email}</span>
                      </div>
                      <div className="mt-1">{getRoleBadge(user.role)}</div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <span className="text-sm text-gray-700">
                        {user.full_name || <span className="text-gray-400 italic">—</span>}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Select
                        className="min-w-[120px]"
                        options={ROLE_EDIT_OPTIONS}
                        value={draft.role}
                        onChange={(e) =>
                          updateDraft(user.id, { role: e.target.value as UserRole })
                        }
                        disabled={saving}
                      />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Select
                        className="min-w-[180px]"
                        options={selectOptions}
                        value={draft.account_id}
                        onChange={(e) =>
                          updateDraft(user.id, { account_id: e.target.value })
                        }
                        disabled={saving}
                      />
                      {missingAccount && (
                        <p className="mt-1 text-xs text-amber-600">
                          No account — user can&apos;t send or sync.
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Toggle
                        checked={draft.is_active}
                        onChange={(val) => updateDraft(user.id, { is_active: val })}
                        disabled={saving}
                      />
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      <span className="text-sm text-gray-500">
                        {user.last_login_at ? timeAgo(user.last_login_at) : (
                          <span className="text-gray-400 italic">Never</span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      <span className="text-sm text-gray-500">
                        {timeAgo(user.created_at)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant={dirty ? 'primary' : 'secondary'}
                        disabled={!dirty || saving}
                        loading={saving}
                        onClick={() => saveRow(user)}
                        className="!py-1.5 !px-3"
                      >
                        {saving ? null : dirty ? <Save className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                        {saving ? 'Saving' : dirty ? 'Save' : 'Saved'}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
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
            label="Account"
            value={inviteAccountId}
            onChange={(e) => setInviteAccountId(e.target.value)}
            options={[
              { value: '', label: '— No account —' },
              ...accounts
                .filter((a) => a.is_active !== false)
                .map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="text-xs text-gray-500">
              This pre-registers the user with their role and account assignment.
              When they sign up via the login page with the same email, they will
              automatically inherit these settings.
            </p>
          </div>
        </div>
      </Modal>
    </div>
  )
}
