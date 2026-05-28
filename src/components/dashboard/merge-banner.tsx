'use client'

// Banner shown on a conversation that is the PRIMARY of one or more merges.
// Lists each merged-in secondary conversation and exposes an "Unmerge" action
// per row. Server passes us a precomputed list — we don't fetch on mount.
//
// A second variant is rendered when the current conversation is itself a
// secondary (merged_into_id is set) — it points the user to the primary so
// they can pick up the unified thread there.

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { GitMerge, Loader2, Undo2, ArrowRight } from 'lucide-react'
import { useToast } from '@/components/ui/toast'
import { useUser } from '@/context/user-context'
import { isSupervisor } from '@/lib/roles'

export interface MergedSecondary {
  id: string
  participant_name: string | null
  participant_email: string | null
  channel: string
  message_count: number
  merged_at: string | null
  merged_by_name: string | null
}

interface MergeBannerProps {
  /** When set, the current conversation is a secondary that was merged INTO this id. */
  mergedIntoId?: string | null
  /** When the current conversation is the PRIMARY, the secondaries that were folded in. */
  mergedSecondaries?: MergedSecondary[]
  /** Required when there are secondaries (used to call the unmerge endpoint). */
  primaryConversationId?: string
}

function formatDate(iso: string | null): string {
  if (!iso) return 'unknown date'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown date'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function MergeBanner({ mergedIntoId, mergedSecondaries, primaryConversationId }: MergeBannerProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { role: viewerRole } = useUser()
  // Phase 2 gate: members see WHICH conversations are merged (informational)
  // but can't unmerge. Only the per-row Unmerge button is hidden; the banner
  // itself stays so they understand the unified thread context.
  const canUnmerge = isSupervisor(viewerRole)
  const [unmerging, setUnmerging] = useState<string | null>(null)

  const handleUnmerge = useCallback(async (secondaryId: string) => {
    if (!primaryConversationId) return
    setUnmerging(secondaryId)
    try {
      const res = await fetch(`/api/conversations/${primaryConversationId}/unmerge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secondary_conversation_id: secondaryId }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data?.error || 'Unmerge failed')
        return
      }
      toast.success('Conversation unmerged. The original thread is back in your inbox.')
      router.refresh()
    } catch (err) {
      toast.error(`Unmerge failed: ${(err as Error).message}`)
    } finally {
      setUnmerging(null)
    }
  }, [primaryConversationId, router, toast])

  if (mergedIntoId) {
    return (
      <div className="shrink-0 mx-4 sm:mx-6 mt-2 rounded-lg border border-purple-200 bg-purple-50 px-4 py-2.5 flex items-center gap-3">
        <GitMerge className="h-4 w-4 text-purple-600 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-purple-900">
            This conversation has been merged into another thread.
          </p>
          <p className="text-xs text-purple-700 mt-0.5">
            Continue the unified discussion on the primary conversation.
          </p>
        </div>
        <Link
          href={`/conversations/${mergedIntoId}`}
          className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-purple-700"
        >
          Open primary
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    )
  }

  if (!mergedSecondaries || mergedSecondaries.length === 0) {
    return null
  }

  return (
    <div className="shrink-0 mx-4 sm:mx-6 mt-2 rounded-lg border border-purple-200 bg-purple-50/70 px-4 py-3">
      <div className="flex items-start gap-3">
        <GitMerge className="h-4 w-4 text-purple-600 flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-purple-900">
            Includes {mergedSecondaries.length} merged conversation{mergedSecondaries.length === 1 ? '' : 's'}
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {mergedSecondaries.map((s) => {
              const name = s.participant_name || s.participant_email || 'Unknown'
              const isUnmerging = unmerging === s.id
              return (
                <li key={s.id} className="flex items-center gap-2 text-xs text-purple-800">
                  <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider">
                    {s.channel}
                  </span>
                  <span className="truncate font-medium">{name}</span>
                  {s.participant_email && s.participant_email !== name && (
                    <span className="truncate text-purple-600">&lt;{s.participant_email}&gt;</span>
                  )}
                  <span className="text-purple-600">·</span>
                  <span className="text-purple-600">
                    {s.message_count} msg{s.message_count === 1 ? '' : 's'}
                  </span>
                  <span className="text-purple-400">·</span>
                  <span className="text-purple-600">
                    merged {formatDate(s.merged_at)}{s.merged_by_name ? ` by ${s.merged_by_name}` : ''}
                  </span>
                  {canUnmerge && (
                    <button
                      type="button"
                      onClick={() => handleUnmerge(s.id)}
                      disabled={isUnmerging}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border border-purple-200 bg-white px-2 py-0.5 text-[11px] font-medium text-purple-700 shadow-sm transition-colors hover:border-purple-300 hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isUnmerging ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Undo2 className="h-3 w-3" />
                      )}
                      Unmerge
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </div>
  )
}
