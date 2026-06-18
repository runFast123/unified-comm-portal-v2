'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { readInboxNavContract } from '@/lib/inbox-nav'

/**
 * ‹ Prev / Next › queue navigation for the conversation detail view.
 *
 * Reads the inbox's stashed displayed order (`inbox:nav:v1`) and, if the
 * current conversation is part of it, renders Prev/Next buttons plus an
 * "i of N" position label so an agent can move through the queue without
 * returning to the list.
 *
 * Graceful by design: when the contract is missing, stale, or doesn't contain
 * the current id, this renders nothing (the header just shows "Back to inbox").
 * The contract is read once on mount — it's a client-only concern (sessionStorage)
 * and the page is server-rendered, so we resolve it after hydration.
 */
export function ConversationQueueNav({ conversationId }: { conversationId: string }) {
  const router = useRouter()
  // null = not yet resolved / not applicable (render nothing).
  const [nav, setNav] = useState<{ ids: string[]; index: number } | null>(null)

  useEffect(() => {
    const contract = readInboxNavContract()
    if (!contract) {
      setNav(null)
      return
    }
    const index = contract.ids.indexOf(conversationId)
    // Current conversation isn't in the stored queue → hide the UI entirely.
    if (index < 0) {
      setNav(null)
      return
    }
    setNav({ ids: contract.ids, index })
  }, [conversationId])

  if (!nav) return null

  const { ids, index } = nav
  const hasPrev = index > 0
  const hasNext = index < ids.length - 1

  const goPrev = () => {
    if (hasPrev) router.push(`/conversations/${ids[index - 1]}`)
  }
  const goNext = () => {
    if (hasNext) router.push(`/conversations/${ids[index + 1]}`)
  }

  return (
    <div className="flex items-center gap-1 shrink-0" aria-label="Queue navigation">
      <button
        type="button"
        onClick={goPrev}
        disabled={!hasPrev}
        title="Previous conversation in queue"
        aria-label="Previous conversation in queue"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400"
      >
        <ChevronLeft size={16} />
      </button>
      <span className="text-xs tabular-nums text-gray-400 whitespace-nowrap" aria-live="polite">
        {index + 1} of {ids.length}
      </span>
      <button
        type="button"
        onClick={goNext}
        disabled={!hasNext}
        title="Next conversation in queue"
        aria-label="Next conversation in queue"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  )
}
