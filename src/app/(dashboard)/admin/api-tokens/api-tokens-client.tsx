'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  KeyRound,
  Plus,
  AlertCircle,
  ShieldAlert,
  Trash2,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input } from '@/components/ui/input'
import { CopyField } from '@/components/ui/copy-field'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/toast'
import { Badge } from '@/components/ui/badge'

export interface TokenRow {
  id: string
  company_id: string
  name: string
  prefix: string
  scopes: string[]
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  expires_at: string | null
}

interface Props {
  initialTokens: TokenRow[]
  knownScopes: string[]
  canCreate: boolean
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

export function ApiTokensClient({ initialTokens, knownScopes, canCreate }: Props) {
  const router = useRouter()
  const { toast } = useToast()
  const [tokens, setTokens] = useState<TokenRow[]>(initialTokens)

  // Create-modal state.
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createScopes, setCreateScopes] = useState<string[]>(['conversations:read'])
  const [createExpires, setCreateExpires] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // After-create plaintext display modal — shown EXACTLY once.
  const [plaintextModal, setPlaintextModal] = useState<{ name: string; plaintext: string } | null>(null)

  const toggleScope = useCallback((scope: string) => {
    setCreateScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    )
  }, [])

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) {
      setCreateError('Name is required')
      return
    }
    if (createScopes.length === 0) {
      setCreateError('Select at least one scope')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch('/api/admin/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createName.trim(),
          scopes: createScopes,
          expires_at: createExpires ? new Date(createExpires).toISOString() : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCreateError(data?.error ?? 'Failed to create token')
        return
      }
      // Insert at top of list — server returned `token` (no plaintext) and
      // `plaintext` separately.
      setTokens((prev) => [
        {
          id: data.token.id,
          company_id: data.token.company_id,
          name: data.token.name,
          prefix: data.token.prefix,
          scopes: data.token.scopes,
          created_at: data.token.created_at,
          last_used_at: null,
          revoked_at: null,
          expires_at: data.token.expires_at ?? null,
        },
        ...prev,
      ])
      setCreateOpen(false)
      setCreateName('')
      setCreateScopes(['conversations:read'])
      setCreateExpires('')
      // Surface the plaintext in a one-time modal.
      setPlaintextModal({ name: data.token.name, plaintext: data.plaintext })
      router.refresh()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setCreating(false)
    }
  }, [createName, createScopes, createExpires, router])

  const handleRevoke = useCallback(
    async (token: TokenRow) => {
      const ok = window.confirm(
        `Revoke API token "${token.name}"?\n\nAny integration using this token will stop working immediately. This cannot be undone.`,
      )
      if (!ok) return
      try {
        const res = await fetch(`/api/admin/api-tokens/${token.id}`, { method: 'DELETE' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data?.error ?? 'Failed to revoke token')
          return
        }
        setTokens((prev) =>
          prev.map((t) =>
            t.id === token.id ? { ...t, revoked_at: data.revoked_at ?? new Date().toISOString() } : t,
          ),
        )
        toast.success('Token revoked')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      }
    },
    [toast],
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <KeyRound className="h-6 w-6 text-teal-700" />
            API Tokens
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Create bearer tokens for Zapier, n8n, custom code, or your CRM. Use them with{' '}
            <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
              Authorization: Bearer ucp_…
            </code>{' '}
            against any{' '}
            <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">/api/v1/</code> endpoint.
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> Create token
          </Button>
        )}
      </div>

      <Card>
        {tokens.length === 0 ? (
          <EmptyState
            icon={<KeyRound className="h-12 w-12" />}
            title="No API tokens yet"
            description="Create your first token to wire the portal into an external integration."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead className="hidden md:table-cell">Last used</TableHead>
                <TableHead className="hidden md:table-cell">Created</TableHead>
                <TableHead className="hidden lg:table-cell">Expires</TableHead>
                <TableHead className="text-right">Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((t) => {
                const isRevoked = !!t.revoked_at
                const isExpired = t.expires_at && new Date(t.expires_at).getTime() <= Date.now()
                return (
                  <TableRow key={t.id} className={isRevoked || isExpired ? 'opacity-60' : ''}>
                    <TableCell className="font-medium text-gray-900">{t.name}</TableCell>
                    <TableCell>
                      <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-800">
                        {t.prefix}…
                      </code>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {t.scopes.length === 0 ? (
                          <span className="text-xs italic text-gray-400">none</span>
                        ) : (
                          t.scopes.map((s) => (
                            <Badge key={s} variant="default">
                              {s}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-gray-600">
                      {formatDate(t.last_used_at)}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-gray-600">
                      {formatDate(t.created_at)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-sm text-gray-600">
                      {formatDate(t.expires_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      {isRevoked ? (
                        <Badge variant="warning">Revoked</Badge>
                      ) : isExpired ? (
                        <Badge variant="warning">Expired</Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!isRevoked && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRevoke(t)}
                          title="Revoke token"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* ── Create modal ───────────────────────────────────────────── */}
      <Modal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false)
          setCreateError(null)
        }}
        title="Create API token"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setCreateOpen(false)
                setCreateError(null)
              }}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={creating || !createName.trim() || createScopes.length === 0}
              loading={creating}
            >
              <Plus className="h-4 w-4" /> Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 text-red-600" />
              <p className="text-sm text-red-700">{createError}</p>
            </div>
          )}
          <Input
            label="Name"
            placeholder="Zapier integration"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            autoFocus
          />
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Scopes</label>
            <div className="space-y-2 rounded-lg border border-gray-200 p-3">
              {knownScopes.map((scope) => (
                <label
                  key={scope}
                  className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={createScopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                    className="h-4 w-4 rounded border-gray-300 text-teal-700 focus:ring-teal-500"
                  />
                  <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">
                    {scope}
                  </code>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              Tokens grant only the scopes you check. Be conservative.
            </p>
          </div>
          <Input
            label="Expires (optional)"
            type="datetime-local"
            value={createExpires}
            onChange={(e) => setCreateExpires(e.target.value)}
          />
          <p className="text-xs text-gray-500">
            Leave blank for a token that never expires. Revoke manually when done.
          </p>
        </div>
      </Modal>

      {/* ── Plaintext-once modal ───────────────────────────────────── */}
      <Modal
        open={plaintextModal !== null}
        onClose={() => setPlaintextModal(null)}
        title="Save your new API token"
        footer={
          <Button onClick={() => setPlaintextModal(null)}>
            <CheckCircle2 className="h-4 w-4" /> I have saved the token
          </Button>
        }
      >
        {plaintextModal && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 text-amber-700 flex-shrink-0" />
              <div className="text-sm text-amber-800">
                <p className="font-semibold">This is the only time you&apos;ll see this token.</p>
                <p className="mt-1">
                  Store it now in your password manager or secret store. We only keep a hash —
                  if you lose it, you&apos;ll need to revoke and create a new one.
                </p>
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm text-gray-700">
                Token for <strong>{plaintextModal.name}</strong>:
              </p>
              <CopyField
                label="Bearer token"
                value={plaintextModal.plaintext}
                helpText='Use as: Authorization: Bearer ucp_…'
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
