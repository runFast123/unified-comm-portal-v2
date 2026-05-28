'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase-client'
import { useUser } from '@/context/user-context'
import { isSuperAdmin } from '@/lib/roles'
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
    case 'super_admin':
      return (
        <Badge variant="teams">
          <Shield className="mr-1 h-3 w-3" /> Super Admin
        </Badge>
      )
    case 'company_admin':
      return (
        <Badge variant="info">
          <Shield className="mr-1 h-3 w-3" /> Company Admin
        </Badge>
      )
    case 'supervisor':
      return (
        <Badge variant="success">
          <UserCheck className="mr-1 h-3 w-3" /> Supervisor
        </Badge>
      )
    case 'company_member':
      return (
        <Badge variant="default">
          <Users className="mr-1 h-3 w-3" /> Member
        </Badge>
      )
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
    default:
      return (
        <Badge variant="default">
          <Eye className="mr-1 h-3 w-3" /> {String(role)}
        </Badge>
      )
  }
}

// Page-level filter dropdown — keeps legacy roles for back-compat with
// existing user rows AND lists the new roles so admins can filter to them.
const ROLE_OPTIONS = [
  { value: '', label: 'All Roles' },
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'company_admin', label: 'Company Admin' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'company_member', label: 'Member' },
  { value: 'admin', label: 'Admin (legacy)' },
  { value: 'reviewer', label: 'Reviewer (legacy)' },
  { value: 'viewer', label: 'Viewer (legacy)' },
]

// New-invite dropdown — mirrors `/admin/companies/[id]` ROLE_OPTIONS so the
// two invite flows offer the same canonical roles. Legacy admin/reviewer/
// viewer are intentionally excluded from NEW invites (still allowed in the
// filter above for existing rows). `super_admin` is appended only when the
// inviter is themselves a super_admin (mirrors the detail-page gating).
const INVITE_ROLE_OPTIONS_BASE = [
  { value: 'company_admin', label: 'Company Admin' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'company_member', label: 'Member' },
]
const INVITE_ROLE_OPTION_SUPER = { value: 'super_admin', label: 'Super Admin' }

const STATUS_OPTIONS = [
  { value: '', label: 'All Status' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
]

// Inline row Select options — canonical post-Phase-1 roles, with `super_admin`
// only surfaced when the current viewer is themselves a super_admin (mirrors
// `INVITE_ROLE_OPTIONS_BASE` above). Legacy admin/reviewer/viewer values are
// NOT offered as new picks here so editors can't accidentally move users TO
// those roles — but if a row's current role IS legacy, we splice that single
// legacy option in dynamically per-row so the Select can still display the
// row's actual value (see `roleEditOptionsFor` inside the component).
const ROLE_EDIT_OPTIONS_BASE = [
  { value: 'company_admin', label: 'Company Admin' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'company_member', label: 'Member' },
]
const ROLE_EDIT_OPTION_SUPER = { value: 'super_admin', label: 'Super Admin' }

// Legacy fallback labels — only used when the current row already has one of
// these roles, so the Select has an option matching `value`. NEVER added to
// every row's dropdown (we don't want admins to silently migrate users INTO
// these legacy roles).
const LEGACY_ROLE_LABELS: Partial<Record<UserRole, string>> = {
  admin: 'Admin (legacy)',
  reviewer: 'Reviewer (legacy)',
  viewer: 'Viewer (legacy)',
}

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
  const currentUser = useUser()
  const canInviteSuperAdmin = isSuperAdmin(currentUser.role)

  // Invite-modal role options — append super_admin only for super_admin
  // inviters. Memoized so the Select's `options` identity is stable.
  const inviteRoleOptions = useMemo(
    () =>
      canInviteSuperAdmin
        ? [...INVITE_ROLE_OPTIONS_BASE, INVITE_ROLE_OPTION_SUPER]
        : INVITE_ROLE_OPTIONS_BASE,
    [canInviteSuperAdmin]
  )

  // Per-row inline role-edit options — mirrors `inviteRoleOptions` but ALSO
  // splices in the row's current role if it's a legacy/non-canonical value
  // so the <Select> always has an option matching `value`. Without this the
  // browser falls back to the first option (silently demoting modern users
  // — the original Bug 3).
  const roleEditOptionsFor = useCallback(
    (currentRole: UserRole) => {
      const base = canInviteSuperAdmin
        ? [ROLE_EDIT_OPTION_SUPER, ...ROLE_EDIT_OPTIONS_BASE]
        : [...ROLE_EDIT_OPTIONS_BASE]
      const alreadyPresent = base.some((o) => o.value === currentRole)
      if (alreadyPresent) return base
      // Row currently has a role not offered in the base list. Splice in a
      // matching option so the Select renders it instead of defaulting to
      // the first item.
      const legacyLabel = LEGACY_ROLE_LABELS[currentRole]
      if (legacyLabel) {
        return [...base, { value: currentRole, label: legacyLabel }]
      }
      // Unknown / future role — show it raw so the row at least matches.
      return [...base, { value: currentRole, label: String(currentRole) }]
    },
    [canInviteSuperAdmin]
  )

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
  const [inviteRole, setInviteRole] = useState<UserRole>('company_member')
  const [inviteAccountId, setInviteAccountId] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  // Fetch users and accounts.
  //
  // Users now come from `/api/admin/users` instead of a client-scoped
  // Supabase query. That endpoint uses the service-role client when the
  // caller is super_admin, so super_admin actually sees users across every
  // company (Bug 5). For company_admin / legacy admin the endpoint returns
  // the same scope the previous RLS-bound query produced — i.e. only their
  // own company's users — so behavior for non-super callers is unchanged.
  //
  // Accounts still go through the user-scoped Supabase client; the page
  // doesn't need cross-company accounts for the assignment dropdown and the
  // existing RLS gives company_admins the right slice.
  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)

    const [usersResult, accountsResult] = await Promise.allSettled([
      fetch('/api/admin/users', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }).then(async (r) => {
        const json = (await r.json().catch(() => ({}))) as {
          users?: User[]
          error?: string
        }
        if (!r.ok) {
          throw new Error(json?.error || `Failed to fetch users (${r.status})`)
        }
        return (json.users ?? []) as User[]
      }),
      supabase
        .from('accounts')
        .select('id, name, is_active')
        .order('name'),
    ])

    if (usersResult.status === 'fulfilled') {
      const fetched = usersResult.value
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
      const errorMsg =
        usersResult.reason instanceof Error
          ? usersResult.reason.message
          : 'Failed to fetch users'
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
  const adminCount = users.filter((u) => ['admin','super_admin','company_admin'].includes(u.role)).length
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

  // Invite handler (pre-registration flow).
  //
  // SECURITY: previously did `supabase.from('users').insert(...)` directly
  // from the client, which let any user with portal access mint accounts
  // at any role — including super_admin. The insert is now done by the
  // server route, which enforces:
  //   - caller is super_admin or company_admin
  //   - company_admin can only assign non-super_admin roles
  //   - the invited user is bound to the caller's company
  // See src/app/api/users/invite/route.ts.
  const handleInvite = useCallback(async () => {
    if (!inviteEmail) return
    setInviting(true)
    setInviteError(null)

    try {
      const res = await fetch('/api/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: inviteEmail.trim().toLowerCase(),
          full_name: inviteName.trim() || null,
          role: inviteRole,
          account_id: inviteAccountId || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setInviteError(data?.error || 'Failed to invite user')
        setInviting(false)
        return
      }

      const inserted = data.user as User
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
      setInviteRole('company_member')
      setInviteAccountId('')
      setInviteError(null)
      setShowInvite(false)
      toast.success(`User ${inviteEmail} pre-registered successfully`)
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Failed to invite user')
    } finally {
      setInviting(false)
    }
  }, [inviteEmail, inviteName, inviteRole, inviteAccountId, toast])

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
                        className="min-w-[140px]"
                        options={roleEditOptionsFor(draft.role)}
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
            options={inviteRoleOptions}
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
