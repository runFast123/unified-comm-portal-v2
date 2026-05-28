'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Crown, Eye, Loader2, Tag, Trash2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface ContactProfileClientProps {
  contactId: string
  initialNotes: string
  initialTags: string[]
  initialIsVip: boolean
  initialDisplayName: string
  isAdmin: boolean
  /**
   * When false, renders a read-only view (no display-name input, no notes
   * textarea, no tag remove/add controls, no VIP toggle, no delete).
   * Defaults to true to preserve the previous behaviour for callers that
   * haven't migrated yet. Companion to the supervisor+ API gate.
   */
  canEdit?: boolean
}

/**
 * Lightweight client island for the contact profile. Owns:
 *   - editable display name
 *   - notes (persists on blur)
 *   - tag chips (add via Enter, remove via X)
 *   - VIP toggle
 *   - admin delete
 *
 * Each mutation hits PATCH /api/contacts/[id]. Errors surface as inline text.
 */
export function ContactProfileClient({
  contactId,
  initialNotes,
  initialTags,
  initialIsVip,
  initialDisplayName,
  isAdmin,
  canEdit = true,
}: ContactProfileClientProps) {
  const router = useRouter()

  const [displayName, setDisplayName] = useState(initialDisplayName)
  const [notes, setNotes] = useState(initialNotes)
  const [tags, setTags] = useState<string[]>(initialTags)
  const [isVip, setIsVip] = useState(initialIsVip)
  const [tagDraft, setTagDraft] = useState('')
  const [savingField, setSavingField] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Track last-saved values so we don't re-PATCH unchanged fields.
  const lastSaved = useRef({
    display_name: initialDisplayName,
    notes: initialNotes,
    tags: initialTags,
    is_vip: initialIsVip,
  })

  async function patch(payload: Record<string, unknown>, field: string) {
    setSavingField(field)
    setError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || `Failed (${res.status})`)
      }
      router.refresh()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      return false
    } finally {
      setSavingField(null)
    }
  }

  async function saveDisplayName() {
    const next = displayName.trim()
    if (next === lastSaved.current.display_name.trim()) return
    const ok = await patch({ display_name: next || null }, 'display_name')
    if (ok) lastSaved.current.display_name = next
  }

  async function saveNotes() {
    if (notes === lastSaved.current.notes) return
    const ok = await patch({ notes }, 'notes')
    if (ok) lastSaved.current.notes = notes
  }

  async function addTag() {
    const t = tagDraft.trim()
    if (!t) return
    if (tags.some((existing) => existing.toLowerCase() === t.toLowerCase())) {
      setTagDraft('')
      return
    }
    const next = [...tags, t]
    setTags(next)
    setTagDraft('')
    const ok = await patch({ tags: next }, 'tags')
    if (ok) lastSaved.current.tags = next
    else setTags(tags) // rollback
  }

  async function removeTag(tag: string) {
    const next = tags.filter((t) => t !== tag)
    setTags(next)
    const ok = await patch({ tags: next }, 'tags')
    if (ok) lastSaved.current.tags = next
    else setTags(tags) // rollback
  }

  async function toggleVip() {
    const next = !isVip
    setIsVip(next)
    const ok = await patch({ is_vip: next }, 'is_vip')
    if (ok) lastSaved.current.is_vip = next
    else setIsVip(!next) // rollback
  }

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || `Failed (${res.status})`)
      }
      router.push('/contacts')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
      setDeleting(false)
    }
  }

  // Keep state synced if router.refresh() brings new server props.
  useEffect(() => {
    setNotes(initialNotes)
    setTags(initialTags)
    setIsVip(initialIsVip)
    setDisplayName(initialDisplayName)
    lastSaved.current = {
      display_name: initialDisplayName,
      notes: initialNotes,
      tags: initialTags,
      is_vip: initialIsVip,
    }
  }, [initialNotes, initialTags, initialIsVip, initialDisplayName])

  // ── Read-only branch ────────────────────────────────────────────────
  // For company_member: render the same shape (display name / tags / notes /
  // VIP indicator) but with no inputs, no save handlers, no delete. A small
  // "View only" banner up top sets expectations.
  if (!canEdit) {
    return (
      <div className="space-y-6">
        <div className="inline-flex items-center gap-1.5 rounded-md bg-gray-50 px-2.5 py-1 text-[11px] font-medium text-gray-500 ring-1 ring-gray-200">
          <Eye className="h-3 w-3" />
          View-only access — contact your supervisor to edit this contact.
        </div>

        {/* VIP indicator (read-only) */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold',
              isVip
                ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-200'
                : 'bg-gray-100 text-gray-500 ring-1 ring-gray-200'
            )}
          >
            <Crown className="h-3 w-3" />
            {isVip ? 'VIP' : 'Not VIP'}
          </span>
        </div>

        {/* Display name (read-only) */}
        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Display Name
          </p>
          <p className="mt-2 text-sm text-gray-800">
            {displayName.trim() || <span className="text-gray-400">No display name</span>}
          </p>
        </div>

        {/* Tags (read-only) */}
        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Tags
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tags.length === 0 ? (
              <span className="text-xs text-gray-400">No tags.</span>
            ) : (
              tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-700 ring-1 ring-teal-200"
                >
                  <Tag className="h-3 w-3" />
                  {tag}
                </span>
              ))
            )}
          </div>
        </div>

        {/* Notes (read-only) */}
        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Notes
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">
            {notes.trim() || <span className="text-gray-400">No notes.</span>}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Quick actions row */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggleVip}
          disabled={savingField === 'is_vip'}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
            isVip
              ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-200 hover:bg-amber-200'
              : 'bg-gray-100 text-gray-600 ring-1 ring-gray-200 hover:bg-gray-200'
          )}
        >
          {savingField === 'is_vip' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Crown className="h-3 w-3" />
          )}
          {isVip ? 'VIP' : 'Mark as VIP'}
        </button>

        {isAdmin && (
          <div className="ml-auto">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-600">Delete this contact?</span>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={handleDelete}
                  loading={deleting}
                >
                  Confirm
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-4 w-4" />
                Delete contact
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Display name */}
      <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Display Name
        </label>
        <Input
          className="mt-2"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          onBlur={saveDisplayName}
          placeholder="e.g. Jane Doe"
        />
        {savingField === 'display_name' && (
          <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-gray-400">
            <Loader2 className="h-3 w-3 animate-spin" /> Saving...
          </p>
        )}
      </div>

      {/* Tags */}
      <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Tags
          </label>
          {savingField === 'tags' && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-400">
              <Loader2 className="h-3 w-3 animate-spin" /> Saving...
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.length === 0 && (
            <span className="text-xs text-gray-400">No tags yet.</span>
          )}
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-700 ring-1 ring-teal-200"
            >
              <Tag className="h-3 w-3" />
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="ml-0.5 rounded-full p-0.5 hover:bg-teal-100"
                aria-label={`Remove ${tag}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void addTag()
              }
            }}
            placeholder="Add a tag and press Enter"
          />
          <Button variant="secondary" size="sm" onClick={addTag} disabled={!tagDraft.trim()}>
            Add
          </Button>
        </div>
      </div>

      {/* Notes */}
      <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Notes
          </label>
          {savingField === 'notes' && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-400">
              <Loader2 className="h-3 w-3 animate-spin" /> Saving...
            </span>
          )}
        </div>
        <textarea
          className="mt-2 w-full min-h-[140px] rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
          placeholder="Internal notes about this contact (saved on blur)..."
        />
      </div>
    </div>
  )
}
