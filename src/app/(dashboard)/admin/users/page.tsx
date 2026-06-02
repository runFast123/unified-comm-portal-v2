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
  Copy,
  X,
  Trash2,
  KeyRound,
} from 'lucide-react'

interface Account {
  id: string
  name: string
  is_active?: boolean
  company_id?: string | null
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
  // Active-tenant scope for the account-assignment dropdowns. `activeCompanyId`
  // null = super_admin combined view (show every account); otherwise restrict
  // the accounts query to the active tenant's account IDs (empty array → zero
  // rows, correct for a tenant with no accounts yet).
  const { activeCompanyId, companyAccountIds } = currentUser
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
  // Pending pre-registrations (invited, not yet signed up). These live in
  // user_invitations (keyed by email) — they have no public.users row until
  // the person signs up and the trigger consumes the invitation.
  const [pendingInvitations, setPendingInvitations] = useState<Array<{
    email: string
    role: UserRole
    account_id: string | null
    company_id: string | null
    full_name: string | null
    created_at: string
  }>>([])
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
  // Company assignment for new invites. Only super_admins choose it (a
  // company_admin is pinned to their own company server-side). The list comes
  // from /api/admin/users; the picker defaults to the active tenant on open.
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([])
  const [inviteCompanyId, setInviteCompanyId] = useState<string>('')

  // Fallback notice shown above the table when the invite email could NOT be
  // sent (Supabase SMTP not configured). Holds the email + shareable signup
  // link so the admin can copy it; null when there's nothing to show.
  // `mode` distinguishes a brand-new invite link ('invite' — "they'll inherit
  // the assigned role on signup") from an admin-regenerated link for someone who
  // already exists ('reset' — just "set a new password"), so the banner copy
  // stays accurate for both.
  const [inviteFallbackLink, setInviteFallbackLink] = useState<
    { email: string; url: string; mode?: 'invite' | 'reset' } | null
  >(null)
  const [fallbackCopied, setFallbackCopied] = useState(false)
  // Tracks the in-flight "regenerate set-password link" request. Holds a user id
  // (table row) or an `invitation:<email>` marker (pending-invitations card), or
  // null when idle — so only the clicked button spins and all link buttons
  // disable while one request is in flight.
  const [linkingId, setLinkingId] = useState<string | null>(null)

  // Delete-user flow. `deleteTarget` drives the confirm modal (null = closed);
  // `deletingId` tracks the in-flight request (a user id, an `invitation:<email>`
  // marker for revokes, or null) so the relevant button shows a spinner and all
  // delete/revoke buttons disable while any one request is in flight.
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

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

    // Scope the account-assignment dropdown to the active tenant. In combined
    // view (activeCompanyId === null) leave it unscoped so super_admin sees
    // every account; with a tenant selected, restrict to that tenant's account
    // IDs (empty array → zero rows, correct for a zero-account tenant).
    let accountsQuery = supabase
      .from('accounts')
      .select('id, name, is_active, company_id')
      .order('name')
    if (activeCompanyId) {
      accountsQuery = accountsQuery.in('id', companyAccountIds)
    }

    const [usersResult, accountsResult] = await Promise.allSettled([
      fetch('/api/admin/users', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }).then(async (r) => {
        const json = (await r.json().catch(() => ({}))) as {
          users?: User[]
          invitations?: Array<{
            email: string
            role: UserRole
            account_id: string | null
            company_id: string | null
            full_name: string | null
            created_at: string
          }>
          companies?: Array<{ id: string; name: string }>
          error?: string
        }
        if (!r.ok) {
          throw new Error(json?.error || `Failed to fetch users (${r.status})`)
        }
        return {
          users: (json.users ?? []) as User[],
          invitations: json.invitations ?? [],
          companies: json.companies ?? [],
        }
      }),
      accountsQuery,
    ])

    if (usersResult.status === 'fulfilled') {
      const fetched = usersResult.value.users
      setPendingInvitations(usersResult.value.invitations)
      setCompanies(usersResult.value.companies)
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
      setPendingInvitations([])
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
  }, [supabase, activeCompanyId, companyAccountIds])

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

  // Count of super_admins currently loaded — used to hide the Delete button on
  // the last remaining super_admin so the UI can't even attempt the action the
  // API blocks (409 "Cannot delete the last super admin"). The API is still the
  // source of truth; this is purely to avoid offering a doomed action.
  const superAdminCount = useMemo(
    () => users.filter((u) => isSuperAdmin(u.role)).length,
    [users]
  )

  // Whether the current viewer may delete a given user row. Mirrors the API's
  // role rules so the button only shows when the request would actually be
  // allowed. NOTE: the user-context does NOT expose the current user's id, so
  // "is self" is detected by comparing emails (case-insensitive).
  const isSelf = useCallback(
    (u: User) =>
      !!currentUser.email &&
      u.email.toLowerCase() === currentUser.email.toLowerCase(),
    [currentUser.email]
  )
  const canDeleteUser = useCallback(
    (u: User): boolean => {
      // Never the caller's own row.
      if (isSelf(u)) return false
      if (isSuperAdmin(currentUser.role)) {
        // super_admin may delete anyone EXCEPT the last remaining super_admin.
        if (isSuperAdmin(u.role) && superAdminCount <= 1) return false
        return true
      }
      // company_admin / legacy admin: cannot delete a super_admin or a legacy
      // 'admin'. (Cross-company rows aren't shown to them by /api/admin/users,
      // so a same-company check would be redundant here.)
      if (isSuperAdmin(u.role) || u.role === 'admin') return false
      return true
    },
    [currentUser.role, isSelf, superAdminCount]
  )

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
    // Super_admins must pick which company the user belongs to (company_admins
    // are pinned to their own company server-side, so they get no picker).
    if (canInviteSuperAdmin && !inviteCompanyId) {
      setInviteError('Please select a company for this user.')
      return
    }
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
          // Only a super_admin may target a company. company_admin invites are
          // pinned to their own company server-side; sending a different id
          // would 403, so we omit it for them entirely.
          ...(canInviteSuperAdmin ? { company_id: inviteCompanyId || null } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setInviteError(data?.error || 'Failed to invite user')
        setInviting(false)
        return
      }

      // The endpoint returns one of these shapes:
      //   { status:'updated', user }                          — email already a real user, updated in place
      //   { status:'invited', email_sent:true }               — invite email sent; auth user created
      //   { status:'invited', email_sent:false, signup_url }  — SMTP off; pre-registered + share-link fallback
      const invitedEmail = inviteEmail.trim().toLowerCase()
      setInviteEmail('')
      setInviteName('')
      setInviteRole('company_member')
      setInviteAccountId('')
      setInviteCompanyId('')
      setInviteError(null)
      setShowInvite(false)

      if (data.status === 'updated') {
        toast.success(`${invitedEmail} updated with the new role and assignment.`)
        setInviteFallbackLink(null)
      } else if (data.email_sent === true) {
        toast.success(data.message || `Invite email sent to ${invitedEmail}.`)
        setInviteFallbackLink(null)
      } else if (data.invite_link) {
        // No email sent (SMTP off), but we generated a real set-password link.
        // This is the normal path right now: show the link for the admin to
        // share. Clicking it confirms the user's email and lets them set a
        // password — no "Email not confirmed" wall.
        toast.success(`${invitedEmail} invited — share their set-password link.`)
        setInviteFallbackLink({ email: invitedEmail, url: data.invite_link })
        setFallbackCopied(false)
      } else {
        // Couldn't even generate a link — fall back to the bare signup link
        // (works only if "Confirm email" is disabled in Supabase).
        toast.warning(
          data.warning ||
            `Couldn't send the invite email. Share the signup link with ${invitedEmail}.`,
          8000
        )
        if (data.signup_url) {
          setInviteFallbackLink({ email: invitedEmail, url: data.signup_url })
          setFallbackCopied(false)
        }
      }
      // Refresh from the server so the users list AND the pending-invitations
      // list both reflect the change (the pre-registered user has no
      // public.users row yet, so it only shows under "Pending invitations").
      await fetchData()
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Failed to invite user')
    } finally {
      setInviting(false)
    }
  }, [inviteEmail, inviteName, inviteRole, inviteAccountId, inviteCompanyId, canInviteSuperAdmin, toast, fetchData])

  // Delete a real user. Called from the confirm modal. The server enforces all
  // the hard guards (self-delete, tenant/privilege bound, last-super-admin);
  // we just relay the result.
  const confirmDeleteUser = useCallback(async () => {
    const target = deleteTarget
    if (!target) return
    setDeletingId(target.id)
    try {
      const res = await fetch('/api/users/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: target.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data?.error || 'Failed to delete user')
        return
      }
      toast.success(`Deleted ${target.email}`)
      setDeleteTarget(null)
      await fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete user')
    } finally {
      setDeletingId(null)
    }
  }, [deleteTarget, toast, fetchData])

  // Revoke a pending pre-registration. Lighter than a real delete (the person
  // never signed up), so it skips the confirm modal and just acts + refetches.
  const revokeInvitation = useCallback(
    async (email: string) => {
      const marker = `invitation:${email}`
      setDeletingId(marker)
      try {
        const res = await fetch('/api/users/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invitation_email: email }),
        })
        const data = await res.json()
        if (!res.ok) {
          toast.error(data?.error || 'Failed to revoke invitation')
          return
        }
        toast.success(`Revoked invitation for ${email}`)
        await fetchData()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to revoke invitation')
      } finally {
        setDeletingId(null)
      }
    },
    [toast, fetchData]
  )

  // Regenerate a fresh set-password / reset link for an existing user (or a
  // pending invitation) and surface it in the share banner. Supabase
  // invite/recovery tokens are single-use and expire, so the original link
  // dies once clicked — this is how an admin hands out a working one again
  // without deleting & re-creating the user. `marker` is the user id or
  // `invitation:<email>` so the right button shows a spinner.
  const generateResetLink = useCallback(
    async (
      target: { user_id?: string; email: string },
      marker: string,
      mode: 'invite' | 'reset'
    ) => {
      setLinkingId(marker)
      try {
        const res = await fetch('/api/users/reset-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            target.user_id ? { user_id: target.user_id } : { email: target.email }
          ),
        })
        const data = await res.json()
        if (!res.ok) {
          toast.error(data?.error || 'Could not generate a set-password link')
          return
        }
        const email = (data.email as string) || target.email
        setInviteFallbackLink({ email, url: data.link, mode })
        setFallbackCopied(false)
        toast.success(`Fresh set-password link ready for ${email}.`)
        // Bring the share banner (rendered above the table) into view.
        if (typeof window !== 'undefined') {
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Could not generate a set-password link'
        )
      } finally {
        setLinkingId(null)
      }
    },
    [toast]
  )

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
        <Button onClick={() => { setInviteCompanyId(activeCompanyId ?? ''); setInviteAccountId(''); setInviteError(null); setShowInvite(true) }}>
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

      {/* Pending invitations — pre-registered emails that haven't signed up
          yet. They have no public.users row; they appear here until the
          person signs up with this email (the trigger then creates their
          user row with the pre-assigned role/account). */}
      {pendingInvitations.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/40">
          <div className="border-b border-amber-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-amber-900">
              Pending invitations ({pendingInvitations.length})
            </h2>
            <p className="mt-0.5 text-xs text-amber-700">
              These people were pre-registered. They&apos;ll inherit the role &amp; account below
              automatically when they sign up with the same email.
            </p>
          </div>
          <div className="divide-y divide-amber-100">
            {pendingInvitations.map((inv) => (
              <div
                key={inv.email}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm"
              >
                <span className="font-medium text-gray-800">{inv.email}</span>
                {getRoleBadge(inv.role)}
                <span className="text-gray-500">
                  {inv.account_id ? (accountMap[inv.account_id] ?? 'Account') : 'No account'}
                </span>
                <span className="ml-auto inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200">
                  Awaiting signup
                </span>
                <Button
                  variant="ghost"
                  disabled={linkingId !== null}
                  loading={linkingId === `invitation:${inv.email}`}
                  onClick={() =>
                    generateResetLink(
                      { email: inv.email },
                      `invitation:${inv.email}`,
                      'invite'
                    )
                  }
                  className="!py-1 !px-2 !text-amber-700 hover:!bg-amber-100"
                  aria-label={`Get a set-password link for ${inv.email}`}
                  title={`Generate a fresh set-password link for ${inv.email}`}
                >
                  {linkingId === `invitation:${inv.email}` ? null : (
                    <KeyRound className="h-3.5 w-3.5" />
                  )}
                  Get link
                </Button>
                <Button
                  variant="ghost"
                  disabled={deletingId !== null}
                  loading={deletingId === `invitation:${inv.email}`}
                  onClick={() => revokeInvitation(inv.email)}
                  className="!py-1 !px-2 !text-amber-700 hover:!bg-amber-100"
                  aria-label={`Revoke invitation for ${inv.email}`}
                  title={`Revoke invitation for ${inv.email}`}
                >
                  {deletingId === `invitation:${inv.email}` ? null : <Trash2 className="h-3.5 w-3.5" />}
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Invite-link notice — the system generated a set-password link for the
          invited user (no email sent because Supabase SMTP isn't configured).
          The admin copies it and sends it however they like. Clicking it
          confirms the user's email and lets them choose a password. */}
      {inviteFallbackLink && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <Mail className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-900">
              {inviteFallbackLink.mode === 'reset' ? (
                <>
                  Send this password link to{' '}
                  <span className="font-semibold">{inviteFallbackLink.email}</span> — it lets
                  them set a new password and sign in:
                </>
              ) : (
                <>
                  Send this set-password link to{' '}
                  <span className="font-semibold">{inviteFallbackLink.email}</span> — it confirms
                  their email and lets them choose a password:
                </>
              )}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="max-w-full truncate rounded border border-amber-200 bg-white px-2 py-1 text-xs text-amber-900">
                {inviteFallbackLink.url}
              </code>
              <Button
                variant="secondary"
                className="!py-1.5 !px-3"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(inviteFallbackLink.url)
                    setFallbackCopied(true)
                    toast.success('Invite link copied to clipboard.')
                    setTimeout(() => setFallbackCopied(false), 2000)
                  } catch {
                    toast.error('Could not copy — select and copy the link manually.')
                  }
                }}
              >
                {fallbackCopied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {fallbackCopied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="mt-2 text-xs text-amber-800">
              {inviteFallbackLink.mode === 'reset'
                ? 'Single-use and time-limited — generate a new one here any time it expires.'
                : 'They’ll inherit the assigned role & account when they sign up with this email.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setInviteFallbackLink(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 text-amber-500 transition-colors hover:bg-amber-100 hover:text-amber-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

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
                <TableHead className="text-right">Actions</TableHead>
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
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="secondary"
                          disabled={linkingId !== null}
                          loading={linkingId === user.id}
                          onClick={() =>
                            generateResetLink(
                              { user_id: user.id, email: user.email },
                              user.id,
                              'reset'
                            )
                          }
                          className="!py-1.5 !px-2.5"
                          aria-label={`Generate a set-password link for ${user.email}`}
                          title={`Generate a fresh set-password / reset link for ${user.email}${
                            user.last_login_at ? '' : ' (they haven’t logged in yet)'
                          }`}
                        >
                          {linkingId === user.id ? null : <KeyRound className="h-3.5 w-3.5" />}
                        </Button>
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
                        {canDeleteUser(user) && (
                          <Button
                            variant="danger"
                            disabled={deletingId !== null}
                            onClick={() => setDeleteTarget(user)}
                            className="!py-1.5 !px-2.5"
                            aria-label={`Delete ${user.email}`}
                            title={`Delete ${user.email}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
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
          {canInviteSuperAdmin && (
            <Select
              label="Company"
              value={inviteCompanyId}
              onChange={(e) => {
                setInviteCompanyId(e.target.value)
                // The previously-selected account may belong to a different
                // company — clear it so we never submit a cross-company pair.
                setInviteAccountId('')
              }}
              options={[
                { value: '', label: '— Select a company —' },
                ...companies.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          )}
          <Select
            label="Account"
            value={inviteAccountId}
            onChange={(e) => setInviteAccountId(e.target.value)}
            options={[
              { value: '', label: '— No account —' },
              ...accounts
                .filter((a) => a.is_active !== false)
                // For a super_admin, only show accounts in the chosen company
                // (the backend rejects a cross-company account anyway). For a
                // company_admin the list is already their company's accounts.
                .filter(
                  (a) =>
                    !canInviteSuperAdmin ||
                    !inviteCompanyId ||
                    a.company_id === inviteCompanyId,
                )
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

      {/* Delete user confirmation */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => { if (deletingId === null) setDeleteTarget(null) }}
        title="Delete user"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setDeleteTarget(null)}
              disabled={deletingId !== null}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={confirmDeleteUser}
              loading={deletingId !== null && deleteTarget !== null && deletingId === deleteTarget.id}
              disabled={deletingId !== null}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-gray-700">
          Delete <span className="font-semibold">{deleteTarget?.email}</span>? This
          removes their login and unassigns their conversations. This can&apos;t be undone.
        </p>
      </Modal>
    </div>
  )
}
