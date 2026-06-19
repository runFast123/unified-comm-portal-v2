'use client'

/**
 * Admin company-default signatures.
 *
 * Lists every company with a one-row preview of its default signature.
 * Click a row to open an editor with the same live preview component
 * the user-level page uses. Per-tenant overrides cascade through the
 * per-user signature when the user disables theirs.
 *
 * Access: super_admin / admin / company_admin (enforced server-side by
 * /api/admin/companies/:id/signature). The sidebar already gates the
 * link behind `user.role === 'admin'` for now; future role-based
 * gating happens in the layout, not here.
 */

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-client'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { useToast } from '@/components/ui/toast'
import { SignaturePreview } from '@/components/dashboard/signature-preview'
import { Loader2, Save, Building2 } from 'lucide-react'
import type { Company } from '@/types/database'

interface CompanyRow extends Company {
  default_email_signature?: string | null
}

const TEMPLATE_EXAMPLE = `**The {{company.name}} team**
support@{{company.name}}.example
{{date}}`

export default function CompanySignaturesPage() {
  const supabase = createClient()
  const { toast } = useToast()
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<CompanyRow | null>(null)
  const [editText, setEditText] = useState('')
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('companies')
      .select('id, name, created_at, default_email_signature')
      .order('name', { ascending: true })
    if (error) {
      toast.error(`Failed to load companies: ${error.message}`)
      setLoading(false)
      return
    }
    setCompanies((data ?? []) as CompanyRow[])
    setLoading(false)
  }, [supabase, toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openEditor = useCallback((c: CompanyRow) => {
    setEditing(c)
    setEditText(c.default_email_signature ?? '')
  }, [])

  const closeEditor = useCallback(() => {
    setEditing(null)
    setEditText('')
  }, [])

  const handleSave = useCallback(async () => {
    if (!editing) return
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/companies/${editing.id}/signature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          default_email_signature: editText.length > 0 ? editText : null,
        }),
      })
      if (!res.ok) {
        let errMsg = 'Failed to save'
        try {
          const j = await res.json()
          if (j?.error) errMsg = j.error
        } catch { /* non-JSON */ }
        throw new Error(errMsg)
      }
      toast.success(`Saved default signature for ${editing.name}`)
      // Reflect in local state without a refetch.
      setCompanies((prev) =>
        prev.map((c) =>
          c.id === editing.id ? { ...c, default_email_signature: editText || null } : c,
        ),
      )
      closeEditor()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [editing, editText, toast, closeEditor])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--brand-accent)]" />
        <span className="ml-3 text-muted-foreground">Loading companies...</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Company Signatures</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set the default email signature each company falls back to when a
          user hasn&apos;t configured their own. Variables like{' '}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">{'{{user.full_name}}'}</code>{' '}
          and <code className="bg-muted px-1 py-0.5 rounded text-xs">{'{{company.name}}'}</code>{' '}
          are substituted at send time.
        </p>
      </div>

      <Card>
        {companies.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            <Building2 className="h-8 w-8 mx-auto text-zinc-500 mb-2" />
            <p className="font-medium text-zinc-700">No companies configured yet</p>
            <p className="text-sm mt-1">
              Add companies via the Account Settings page first.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {companies.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => openEditor(c)}
                className="w-full text-left flex items-center justify-between gap-4 px-3 py-3 hover:bg-muted transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Building2 className="h-4 w-4 text-zinc-500 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {c.default_email_signature?.trim()
                        ? c.default_email_signature.split('\n')[0].slice(0, 100)
                        : <span className="italic">No default signature</span>}
                    </p>
                  </div>
                </div>
                <span className="text-xs text-[var(--brand-accent)] font-medium shrink-0">Edit →</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={!!editing}
        onClose={closeEditor}
        title={editing ? `Default signature — ${editing.name}` : ''}
        className="sm:max-w-3xl"
      >
        {editing && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1.5">
                  Signature template (markdown)
                </label>
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={12}
                  placeholder={`e.g.\n${TEMPLATE_EXAMPLE}`}
                  className="w-full rounded-lg border border-border px-3 py-2 font-mono text-sm focus:border-[var(--brand-accent)] focus:ring-1 focus:ring-[var(--brand-accent)] focus:outline-none resize-y"
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Variables:{' '}
                  <code className="bg-muted px-1 py-0.5 rounded">{'{{user.full_name}}'}</code>{' '}
                  <code className="bg-muted px-1 py-0.5 rounded">{'{{user.email}}'}</code>{' '}
                  <code className="bg-muted px-1 py-0.5 rounded">{'{{company.name}}'}</code>{' '}
                  <code className="bg-muted px-1 py-0.5 rounded">{'{{date}}'}</code>
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1.5">Live preview</label>
                <div className="rounded-lg border border-border bg-card p-4 min-h-[200px]">
                  <SignaturePreview
                    template={editText}
                    context={{
                      // Server substitutes per-user values at send time. Here
                      // we use placeholder strings so admins can see what
                      // each variable resolves to without having a real user.
                      full_name: 'Jane Doe',
                      email: 'jane@example.com',
                      company_name: editing.name,
                    }}
                    showDelimiter
                  />
                </div>
                <p className="mt-2 text-[11px] text-zinc-500">
                  User-specific variables shown with sample values. Real sends
                  use the actual sender&apos;s name/email.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-border">
              <Button variant="ghost" onClick={closeEditor} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleSave} loading={saving} disabled={saving}>
                <Save size={14} />
                Save default signature
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
