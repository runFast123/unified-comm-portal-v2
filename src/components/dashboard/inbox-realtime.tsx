'use client'

import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase-client'

/**
 * Realtime awareness for the inbox LIST. Subscribes to message/conversation
 * inserts+updates via Supabase Postgres Changes — which are RLS-scoped, so an
 * authenticated agent only ever receives events for their OWN company's rows
 * (same tenant boundary as a normal SELECT; no cross-tenant exposure). When new
 * activity arrives it shows a non-disruptive "new activity" pill rather than
 * yanking the list out from under an agent who may be mid-selection; clicking it
 * calls `onRefresh` (the inbox's own refetch). The 2-min poller stays as a
 * fallback. The conversation DETAIL view has its own realtime (ConversationRealtime).
 */
export function InboxRealtime({ onRefresh }: { onRefresh: () => void }) {
  const [hasNew, setHasNew] = useState(false)
  // Ref so the (mount-only) subscription always calls the latest refetch
  // (which closes over the current filters) without re-subscribing.
  const onRefreshRef = useRef(onRefresh)
  useEffect(() => {
    onRefreshRef.current = onRefresh
  }, [onRefresh])

  useEffect(() => {
    const supabase = createClient()
    const bump = () => setHasNew(true)
    const channel = supabase
      .channel('inbox-list-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, bump)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations' }, bump)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, bump)
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [])

  if (!hasNew) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[72px] z-40 flex justify-center px-4">
      <button
        type="button"
        onClick={() => {
          setHasNew(false)
          onRefreshRef.current()
        }}
        className="pointer-events-auto inline-flex animate-slide-up items-center gap-2 rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-lg ring-1 ring-black/10 transition hover:bg-gray-800"
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
        </span>
        New activity
        <RefreshCw className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
