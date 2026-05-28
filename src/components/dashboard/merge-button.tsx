'use client'

// "Merge" button + modal flow for the conversation header.
//
// Three states inside the modal:
//   1. picker  — list candidate conversations from the same person; user picks one
//   2. preview — show the merge plan (combined message count, time range, etc.)
//                and ask for explicit confirmation
//   3. busy    — fetch / merge in flight
//
// On success we navigate to the primary's URL (which is also the current
// conversation, but a router.refresh() is needed to re-fetch the merged
// thread). The merge endpoint always uses the URL conversation as the
// PRIMARY — the picker exposes the chosen "secondary" only.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { GitMerge, Loader2, X, ArrowRight } from 'lucide-react'
import { useToast } from '@/components/ui/toast'
import { useUser } from '@/context/user-context'
import { isSupervisor } from '@/lib/roles'

interface MergeCandidate {
  id: string
  channel: string
  participant_name: string | null
  participant_email: string | null
  participant_phone: string | null
  message_count: number
  last_message_at: string | null
  preview: string | null
}

interface MergePreview {
  primary: MergePreviewSide
  secondary: MergePreviewSide
  combined_message_count: number
  combined_first_message_at: string | null
  combined_last_message_at: string | null
  allowed: boolean
  blocked_reason: string | null
}

interface MergePreviewSide {
  id: string
  participant_name: string | null
  participant_email: string | null
  channel: string
  message_count: number
  first_message_at: string | null
  last_message_at: string | null
}

interface Props {
  conversationId: string
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function MergeButton({ conversationId }: Props) {
  const router = useRouter()
  const { toast } = useToast()
  const { role: viewerRole } = useUser()
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<'picker' | 'preview'>('picker')
  const [candidates, setCandidates] = useState<MergeCandidate[]>([])
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [selectedSecondaryId, setSelectedSecondaryId] = useState<string | null>(null)
  const [preview, setPreview] = useState<MergePreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [merging, setMerging] = useState(false)

  // Reset modal state on close.
  useEffect(() => {
    if (!open) {
      setStage('picker')
      setSelectedSecondaryId(null)
      setPreview(null)
    }
  }, [open])

  // Esc closes.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !merging) {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, merging])

  // Load candidates when the modal opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingCandidates(true)
    fetch(`/api/conversations/${conversationId}/merge-candidates`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        if (data?.candidates) setCandidates(data.candidates)
      })
      .catch(() => {
        if (cancelled) return
        toast.error('Failed to load merge candidates')
      })
      .finally(() => {
        if (!cancelled) setLoadingCandidates(false)
      })
    return () => { cancelled = true }
  }, [open, conversationId, toast])

  const handlePick = useCallback(async (secondaryId: string) => {
    setSelectedSecondaryId(secondaryId)
    setLoadingPreview(true)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/merge-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secondary_conversation_id: secondaryId }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data?.error || 'Failed to load preview')
        setSelectedSecondaryId(null)
        return
      }
      setPreview(data.preview)
      setStage('preview')
    } catch (err) {
      toast.error(`Preview failed: ${(err as Error).message}`)
      setSelectedSecondaryId(null)
    } finally {
      setLoadingPreview(false)
    }
  }, [conversationId, toast])

  const handleConfirm = useCallback(async () => {
    if (!selectedSecondaryId || !preview?.allowed) return
    setMerging(true)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secondary_conversation_id: selectedSecondaryId }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data?.error || 'Merge failed')
        return
      }
      toast.success(`Merged ${data?.merge?.message_ids?.length ?? 0} messages into this conversation.`)
      setOpen(false)
      // Stay on the primary conversation, just refresh.
      router.refresh()
    } catch (err) {
      toast.error(`Merge failed: ${(err as Error).message}`)
    } finally {
      setMerging(false)
    }
  }, [selectedSecondaryId, preview, conversationId, router, toast])

  const triggerLabel = useMemo(() => 'Merge', [])

  // Phase 2 gate: merge is a destructive cross-conversation op restricted to
  // supervisor+. Render nothing for members — there's no read-only fallback
  // since "Merge" has no view-only meaning. The /merge API enforces the
  // same check server-side.
  if (!isSupervisor(viewerRole)) {
    return null
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700"
        title="Merge this conversation with another from the same person"
      >
        <GitMerge className="h-3.5 w-3.5" />
        {triggerLabel}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !merging) setOpen(false)
          }}
        >
          <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-50 text-purple-700 ring-1 ring-purple-200">
                  <GitMerge className="h-3.5 w-3.5" strokeWidth={2.25} />
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {stage === 'picker' ? 'Merge with another conversation' : 'Confirm merge'}
                  </p>
                  <p className="text-[11px] text-gray-500">
                    {stage === 'picker'
                      ? 'Pick a conversation from the same person to combine into this one.'
                      : 'Review what will move. The secondary stays as an audit row and can be unmerged later.'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => !merging && setOpen(false)}
                className="rounded-full p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
                disabled={merging}
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="max-h-[60vh] overflow-y-auto">
              {stage === 'picker' && (
                <div className="px-5 py-4">
                  {loadingCandidates ? (
                    <div className="flex items-center justify-center py-12 text-gray-400">
                      <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                  ) : candidates.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-10 text-center text-sm text-gray-500">
                      No matching conversations found for this participant.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {candidates.map((c) => {
                        const name = c.participant_name || c.participant_email || c.participant_phone || 'Unknown'
                        const isLoading = loadingPreview && selectedSecondaryId === c.id
                        return (
                          <li key={c.id}>
                            <button
                              type="button"
                              onClick={() => handlePick(c.id)}
                              disabled={loadingPreview}
                              className="flex w-full items-start gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-left transition-colors hover:border-purple-300 hover:bg-purple-50/40 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <p className="truncate text-sm font-semibold text-gray-900">{name}</p>
                                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-600">
                                    {c.channel}
                                  </span>
                                </div>
                                {c.participant_email && (
                                  <p className="truncate text-xs text-gray-500">{c.participant_email}</p>
                                )}
                                {c.preview && (
                                  <p className="mt-1 line-clamp-1 text-xs text-gray-600">{c.preview}</p>
                                )}
                                <p className="mt-1 text-[11px] text-gray-400">
                                  {c.message_count} message{c.message_count === 1 ? '' : 's'} · last activity {formatDate(c.last_message_at)}
                                </p>
                              </div>
                              {isLoading ? (
                                <Loader2 className="mt-1 h-4 w-4 animate-spin text-purple-500" />
                              ) : (
                                <ArrowRight className="mt-1 h-4 w-4 text-gray-300" />
                              )}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )}

              {stage === 'preview' && preview && (
                <div className="space-y-4 px-5 py-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <PreviewSideCard label="Primary (kept)" side={preview.primary} accent="teal" />
                    <PreviewSideCard label="Secondary (merged in)" side={preview.secondary} accent="purple" />
                  </div>

                  <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
                    <p className="font-semibold text-gray-900">After merge</p>
                    <ul className="mt-1.5 space-y-1 text-xs text-gray-600">
                      <li>· {preview.combined_message_count} total messages on the primary thread</li>
                      <li>· Active range: {formatDate(preview.combined_first_message_at)} → {formatDate(preview.combined_last_message_at)}</li>
                      <li>· Secondary conversation will be hidden from the inbox (reversible via &quot;Unmerge&quot;)</li>
                    </ul>
                  </div>

                  {!preview.allowed && (
                    <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
                      {preview.blocked_reason || 'This merge is not allowed.'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50 px-5 py-3">
              <button
                type="button"
                onClick={() => {
                  if (stage === 'preview') {
                    setStage('picker')
                    setPreview(null)
                    setSelectedSecondaryId(null)
                  } else if (!merging) {
                    setOpen(false)
                  }
                }}
                disabled={merging}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
              >
                {stage === 'preview' ? 'Back' : 'Cancel'}
              </button>
              {stage === 'preview' && (
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={merging || !preview?.allowed}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {merging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />}
                  Merge into this conversation
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function PreviewSideCard({
  label,
  side,
  accent,
}: {
  label: string
  side: MergePreviewSide
  accent: 'teal' | 'purple'
}) {
  const accentClasses = accent === 'teal'
    ? 'border-teal-200 bg-teal-50/50 text-teal-800'
    : 'border-purple-200 bg-purple-50/50 text-purple-800'
  return (
    <div className={`rounded-lg border ${accentClasses} px-4 py-3`}>
      <p className="text-[10px] font-semibold uppercase tracking-wider opacity-70">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-gray-900">
        {side.participant_name || side.participant_email || 'Unknown'}
      </p>
      {side.participant_email && (
        <p className="truncate text-xs text-gray-500">{side.participant_email}</p>
      )}
      <p className="mt-1.5 text-[11px] text-gray-500">
        {side.channel} · {side.message_count} message{side.message_count === 1 ? '' : 's'}
      </p>
      <p className="mt-0.5 text-[11px] text-gray-400">last activity {formatDate(side.last_message_at)}</p>
    </div>
  )
}
