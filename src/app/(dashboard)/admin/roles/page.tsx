'use client'

import { useState, useEffect, useCallback } from 'react'
import { ShieldCheck, Loader2, Check, X, Info } from 'lucide-react'
import { useToast } from '@/components/ui/toast'
import { Skeleton } from '@/components/ui/skeleton'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/permissions/defaults'
import {
  SECTION_PERMISSIONS,
  ACTION_PERMISSIONS,
  CHANNEL_PERMISSION_KEYS,
} from '@/lib/permissions/catalog'
import { getChannel } from '@/lib/channels/registry'
import type { UserRole } from '@/types/database'

// Role columns — super_admin is locked all-access and never editable.
const ROLE_COLUMNS: { role: string; label: string; locked?: boolean }[] = [
  { role: 'super_admin', label: 'Super Admin', locked: true },
  { role: 'company_admin', label: 'Company Admin' },
  { role: 'admin', label: 'Admin' },
  { role: 'supervisor', label: 'Supervisor' },
  { role: 'company_member', label: 'Member' },
  { role: 'reviewer', label: 'Reviewer' },
  { role: 'viewer', label: 'Viewer' },
]

function channelLabel(key: string): string {
  const ch = key.replace('channel:', '')
  return getChannel(ch)?.label ?? ch
}

const GROUPS: { label: string; enforced: boolean; perms: [string, string][] }[] = [
  { label: 'Sections', enforced: true, perms: Object.entries(SECTION_PERMISSIONS) },
  { label: 'Actions', enforced: false, perms: Object.entries(ACTION_PERMISSIONS) },
  { label: 'Channels', enforced: false, perms: CHANNEL_PERMISSION_KEYS.map((k) => [k, channelLabel(k)] as [string, string]) },
]

interface RoleDelta { role: string; permission_key: string; allowed: boolean }
interface UserRow { id: string; full_name: string | null; email: string; role: string }

function baselineHas(role: string, key: string): boolean {
  return DEFAULT_ROLE_PERMISSIONS[role as UserRole]?.has(key) ?? false
}

export default function RolesPage() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'roles' | 'users' | 'models'>('roles')
  const [deltas, setDeltas] = useState<Map<string, boolean>>(new Map())
  const [users, setUsers] = useState<UserRow[]>([])
  const [savingCell, setSavingCell] = useState<string | null>(null)

  // Per-user override panel state.
  const [selectedUser, setSelectedUser] = useState<UserRow | null>(null)
  const [overrides, setOverrides] = useState<Map<string, 'allow' | 'deny'>>(new Map())
  const [userLoading, setUserLoading] = useState(false)

  // Models tab — per-role / per-user AI model assignment.
  const [modelProviders, setModelProviders] = useState<{ id: string; name: string; model: string }[]>([])
  const [roleModelMap, setRoleModelMap] = useState<Map<string, string>>(new Map())
  const [userModelMap, setUserModelMap] = useState<Map<string, string>>(new Map())
  const [modelLoading, setModelLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/permissions')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      const m = new Map<string, boolean>()
      for (const d of (data.roleDeltas ?? []) as RoleDelta[]) m.set(`${d.role}|${d.permission_key}`, d.allowed)
      setDeltas(m)
      setUsers((data.users ?? []) as UserRow[])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  const loadModels = useCallback(async () => {
    setModelLoading(true)
    try {
      const res = await fetch('/api/admin/permissions/models')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load models')
      setModelProviders(data.providers ?? [])
      const rm = new Map<string, string>()
      const um = new Map<string, string>()
      for (const a of (data.assignments ?? []) as Array<{ role: string | null; user_id: string | null; ai_provider_id: string }>) {
        if (a.role) rm.set(a.role, a.ai_provider_id)
        else if (a.user_id) um.set(a.user_id, a.ai_provider_id)
      }
      setRoleModelMap(rm)
      setUserModelMap(um)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setModelLoading(false)
    }
  }, [toast])

  useEffect(() => { loadModels() }, [loadModels])

  const setModel = async (scope: 'role' | 'user', key: string, providerId: string | null) => {
    const map = scope === 'role' ? roleModelMap : userModelMap
    const setMap = scope === 'role' ? setRoleModelMap : setUserModelMap
    const prev = new Map(map)
    const next = new Map(map)
    if (providerId) next.set(key, providerId)
    else next.delete(key)
    setMap(next)
    try {
      const res = await fetch('/api/admin/permissions/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          scope === 'role'
            ? { scope, role: key, ai_provider_id: providerId }
            : { scope, user_id: key, ai_provider_id: providerId }
        ),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
    } catch (e) {
      setMap(prev)
      toast.error((e as Error).message)
    }
  }

  const effective = (role: string, key: string): boolean => {
    if (role === 'super_admin') return true
    const k = `${role}|${key}`
    return deltas.has(k) ? deltas.get(k)! : baselineHas(role, key)
  }

  const toggleCell = async (role: string, key: string) => {
    if (role === 'super_admin') return
    const cellId = `${role}|${key}`
    const next = !effective(role, key)
    const baseline = baselineHas(role, key)
    const prev = new Map(deltas)
    const optimistic = new Map(deltas)
    if (next === baseline) optimistic.delete(cellId)
    else optimistic.set(cellId, next)
    setDeltas(optimistic)
    setSavingCell(cellId)
    try {
      const res = await fetch('/api/admin/permissions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, permission_key: key, allowed: next === baseline ? null : next }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
    } catch (e) {
      setDeltas(prev)
      toast.error((e as Error).message)
    } finally {
      setSavingCell(null)
    }
  }

  // ── Per-user overrides ──────────────────────────────────────────────
  const openUser = async (u: UserRow) => {
    setSelectedUser(u)
    setUserLoading(true)
    setOverrides(new Map())
    try {
      const res = await fetch(`/api/admin/permissions/user?user_id=${u.id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load user')
      const m = new Map<string, 'allow' | 'deny'>()
      for (const o of (data.overrides ?? []) as Array<{ permission_key: string; effect: 'allow' | 'deny' }>) {
        m.set(o.permission_key, o.effect)
      }
      setOverrides(m)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUserLoading(false)
    }
  }

  const userEffective = (role: string, key: string): boolean => {
    if (role === 'super_admin') return true
    const ov = overrides.get(key)
    if (ov) return ov === 'allow'
    return effective(role, key)
  }

  const setOverride = async (key: string, effect: 'allow' | 'deny' | null) => {
    if (!selectedUser) return
    const prev = new Map(overrides)
    const optimistic = new Map(overrides)
    if (effect) optimistic.set(key, effect)
    else optimistic.delete(key)
    setOverrides(optimistic)
    try {
      const res = await fetch('/api/admin/permissions/user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: selectedUser.id, permission_key: key, effect }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
    } catch (e) {
      setOverrides(prev)
      toast.error((e as Error).message)
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-teal-700" />
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Roles &amp; Permissions</h1>
            <p className="text-sm text-muted-foreground">
              Control which sections, channels, and actions each role — and individual users — can access.
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-3 border-b border-border pb-2">
          <Skeleton className="h-5 w-16 rounded" />
          <Skeleton className="h-5 w-16 rounded" />
          <Skeleton className="h-5 w-20 rounded" />
        </div>

        {/* Permission matrix */}
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center gap-3 border-b border-border bg-muted px-4 py-2.5">
            <Skeleton className="h-3 w-28 rounded" />
            <div className="ml-auto flex gap-6">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-3 w-16 rounded" />
              ))}
            </div>
          </div>
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
              <Skeleton className="h-4 w-40 rounded" />
              <div className="ml-auto flex gap-6">
                {Array.from({ length: 5 }).map((_, j) => (
                  <Skeleton key={j} className="h-4 w-16 rounded" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-teal-700" />
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Roles &amp; Permissions</h1>
          <p className="text-sm text-muted-foreground">
            Control which sections, channels, and actions each role — and individual users — can access.
          </p>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[13px] text-blue-800">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <span>
          Changes apply on top of the built-in role defaults and take effect immediately. A dot marks a
          permission you&apos;ve customized from its default. <strong>Sections</strong> are enforced now;
          enforcement for Actions &amp; Channels is rolling out. <strong>Super Admin</strong> always has full access.
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(['roles', 'users', 'models'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'px-4 py-2 text-sm font-medium -mb-px border-b-2 ' +
              (tab === t
                ? 'border-teal-600 text-teal-700'
                : 'border-transparent text-muted-foreground hover:text-zinc-700')
            }
          >
            {t === 'roles' ? 'By role' : t === 'users' ? 'By user' : 'AI models'}
          </button>
        ))}
      </div>

      {tab === 'models' ? (
        <ModelsTab
          providers={modelProviders}
          roleModel={roleModelMap}
          userModel={userModelMap}
          users={users}
          loading={modelLoading}
          onSet={setModel}
        />
      ) : tab === 'roles' ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="bg-muted">
                <th className="sticky left-0 z-10 bg-muted px-4 py-2 text-left font-semibold text-zinc-700">
                  Permission
                </th>
                {ROLE_COLUMNS.map((c) => (
                  <th key={c.role} className="px-3 py-2 text-center font-semibold text-zinc-700 whitespace-nowrap">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {GROUPS.map((group) => (
                <GroupRows
                  key={group.label}
                  group={group}
                  effective={effective}
                  isModified={(role, key) => deltas.has(`${role}|${key}`)}
                  savingCell={savingCell}
                  onToggle={toggleCell}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
          {/* User list */}
          <div className="rounded-lg border border-border divide-y max-h-[70vh] overflow-y-auto">
            {users.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">No users in this company.</div>
            )}
            {users.map((u) => (
              <button
                key={u.id}
                onClick={() => openUser(u)}
                className={
                  'flex w-full flex-col items-start px-4 py-2.5 text-left hover:bg-muted ' +
                  (selectedUser?.id === u.id ? 'bg-teal-50' : '')
                }
              >
                <span className="font-medium text-foreground truncate max-w-full">{u.full_name || u.email}</span>
                <span className="text-xs text-muted-foreground">{u.role}</span>
              </button>
            ))}
          </div>

          {/* Override panel */}
          <div className="rounded-lg border border-border p-4">
            {!selectedUser ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                Select a user to manage their individual overrides.
              </div>
            ) : userLoading ? (
              <div className="flex h-40 items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : selectedUser.role === 'super_admin' ? (
              <div className="text-sm text-muted-foreground">Super Admin always has full access; no overrides apply.</div>
            ) : (
              <div className="space-y-5">
                <div className="text-sm text-zinc-600">
                  Overrides for <strong>{selectedUser.full_name || selectedUser.email}</strong>{' '}
                  <span className="text-zinc-500">({selectedUser.role})</span> — these win over the role defaults.
                </div>
                {GROUPS.map((group) => (
                  <div key={group.label}>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{group.label}</div>
                    <div className="divide-y">
                      {group.perms.map(([key, label]) => {
                        const ov = overrides.get(key) ?? null
                        const eff = userEffective(selectedUser.role, key)
                        return (
                          <div key={key} className="flex items-center justify-between gap-3 py-1.5">
                            <span className="text-sm text-zinc-700">
                              {label}
                              <span className={'ml-2 text-xs ' + (eff ? 'text-emerald-600' : 'text-zinc-500')}>
                                {eff ? 'allowed' : 'denied'}
                              </span>
                            </span>
                            <div className="flex gap-1">
                              {(['default', 'allow', 'deny'] as const).map((opt) => {
                                const active = opt === 'default' ? ov === null : ov === opt
                                return (
                                  <button
                                    key={opt}
                                    onClick={() => setOverride(key, opt === 'default' ? null : opt)}
                                    className={
                                      'rounded px-2 py-1 text-xs font-medium ring-1 ' +
                                      (active
                                        ? opt === 'allow'
                                          ? 'bg-emerald-600 text-white ring-emerald-600'
                                          : opt === 'deny'
                                            ? 'bg-red-600 text-white ring-red-600'
                                            : 'bg-zinc-700 text-white ring-zinc-700'
                                        : 'bg-card text-zinc-600 ring-border hover:bg-muted')
                                    }
                                  >
                                    {opt === 'default' ? 'Default' : opt === 'allow' ? 'Allow' : 'Deny'}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Matrix group + cells (kept as a child so each group renders its header) ──
function GroupRows({
  group,
  effective,
  isModified,
  savingCell,
  onToggle,
}: {
  group: { label: string; enforced: boolean; perms: [string, string][] }
  effective: (role: string, key: string) => boolean
  isModified: (role: string, key: string) => boolean
  savingCell: string | null
  onToggle: (role: string, key: string) => void
}) {
  return (
    <>
      <tr>
        <td colSpan={ROLE_COLUMNS.length + 1} className="bg-muted/70 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {group.label}
          {!group.enforced && <span className="ml-2 font-normal normal-case text-zinc-500">(enforcement rolling out)</span>}
        </td>
      </tr>
      {group.perms.map(([key, label]) => (
        <tr key={key} className="border-t border-border hover:bg-muted/50">
          <td className="sticky left-0 z-10 bg-card px-4 py-1.5 text-zinc-700 whitespace-nowrap">{label}</td>
          {ROLE_COLUMNS.map((c) => {
            const on = effective(c.role, key)
            const modified = !c.locked && isModified(c.role, key)
            const cellId = `${c.role}|${key}`
            return (
              <td key={c.role} className="px-3 py-1.5 text-center">
                <button
                  disabled={c.locked || savingCell === cellId}
                  onClick={() => onToggle(c.role, key)}
                  title={c.locked ? 'Super Admin always has full access' : modified ? 'Customized from default' : 'Default'}
                  className={
                    'relative inline-flex h-8 w-8 items-center justify-center rounded-md ring-1 transition ' +
                    (on
                      ? 'bg-emerald-50 text-emerald-600 ring-emerald-200'
                      : 'bg-muted text-zinc-500 ring-border') +
                    (c.locked ? ' opacity-60 cursor-not-allowed' : ' hover:ring-teal-300 cursor-pointer')
                  }
                >
                  {savingCell === cellId ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : on ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                  {modified && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />}
                </button>
              </td>
            )
          })}
        </tr>
      ))}
    </>
  )
}

// ── Models tab: assign a specific AI provider to a role or user ──────────────
function ModelsTab({
  providers,
  roleModel,
  userModel,
  users,
  loading,
  onSet,
}: {
  providers: { id: string; name: string; model: string }[]
  roleModel: Map<string, string>
  userModel: Map<string, string>
  users: UserRow[]
  loading: boolean
  onSet: (scope: 'role' | 'user', key: string, providerId: string | null) => void
}) {
  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading models…
      </div>
    )
  }
  if (providers.length === 0) {
    return (
      <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
        No AI providers configured for this company yet. Add one in <strong>AI Settings</strong> first.
      </div>
    )
  }
  const Dropdown = ({ value, onChange }: { value: string; onChange: (v: string | null) => void }) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value || null)}
      className="rounded-md border border-border bg-card px-2 py-1 text-sm text-zinc-700"
    >
      <option value="">Company default</option>
      {providers.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} · {p.model}
        </option>
      ))}
    </select>
  )
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[13px] text-blue-800">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <span>
          Assign a specific model to a role or user. Unassigned = the company default (set in AI Settings).
          A user assignment wins over their role. Applies to user-triggered AI (e.g. Summarize).
        </span>
      </div>
      <div className="rounded-lg border border-border">
        <div className="border-b bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By role</div>
        <div className="divide-y">
          {ROLE_COLUMNS.filter((r) => !r.locked).map((r) => (
            <div key={r.role} className="flex items-center justify-between px-4 py-2">
              <span className="text-sm text-zinc-700">{r.label}</span>
              <Dropdown value={roleModel.get(r.role) ?? ''} onChange={(v) => onSet('role', r.role, v)} />
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-border">
        <div className="border-b bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By user</div>
        <div className="max-h-[50vh] divide-y overflow-y-auto">
          {users.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">No users in this company.</div>
          )}
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between px-4 py-2">
              <span className="text-sm text-zinc-700">
                {u.full_name || u.email} <span className="text-xs text-zinc-500">({u.role})</span>
              </span>
              <Dropdown value={userModel.get(u.id) ?? ''} onChange={(v) => onSet('user', u.id, v)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
