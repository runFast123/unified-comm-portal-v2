'use client'

import { useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase-client'

interface UseRealtimeMessagesOptions {
  onNewMessage?: (message: any) => void
  enabled?: boolean
}

/**
 * Hook that subscribes to real-time message inserts via Supabase Realtime.
 * Triggers onNewMessage callback when a new inbound message arrives.
 */
export function useRealtimeMessages({ onNewMessage, enabled = true }: UseRealtimeMessagesOptions) {
  const handleMessage = useCallback((payload: any) => {
    if (payload.new && payload.new.direction === 'inbound') {
      onNewMessage?.(payload.new)
    }
  }, [onNewMessage])

  useEffect(() => {
    if (!enabled) return

    const supabase = createClient()
    const channel = supabase
      .channel('inbox-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: 'direction=eq.inbound',
        },
        handleMessage
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [enabled, handleMessage])
}
