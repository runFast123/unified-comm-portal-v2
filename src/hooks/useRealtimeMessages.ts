'use client'

import { useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase-client'

interface UseRealtimeMessagesOptions {
  onNewMessage?: (message: any) => void
  enabled?: boolean
  /**
   * Optional account IDs the caller is allowed to see. When provided, the hook
   * filters realtime inserts to only those accounts so non-admin users do not
   * receive cross-tenant pulses. Pass an empty array (or omit) for admins.
   */
  accountIds?: string[]
}

/**
 * Hook that subscribes to real-time message inserts via Supabase Realtime.
 * Triggers onNewMessage callback when a new inbound message arrives.
 */
export function useRealtimeMessages({ onNewMessage, enabled = true, accountIds }: UseRealtimeMessagesOptions) {
  // Stable per-instance channel name. A constant name causes Supabase to
  // reject duplicate .subscribe() calls when the hook mounts in multiple
  // places (sidebar + inbox page) or multiple tabs of the same app.
  const channelNameRef = useRef<string>('')
  if (!channelNameRef.current) {
    channelNameRef.current = `inbox-realtime-${
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2)
    }`
  }

  // Snapshot accountIds so the callback re-binds when the set changes
  const accountIdsKey = accountIds && accountIds.length > 0 ? accountIds.slice().sort().join(',') : ''

  const handleMessage = useCallback((payload: any) => {
    if (!payload.new || payload.new.direction !== 'inbound') return
    // Tenant scoping: when accountIds is supplied (non-admin user), drop
    // events for accounts the caller can't see. Supabase realtime filters
    // only accept one expression, so we keep direction server-side and
    // enforce account scope here.
    if (accountIdsKey) {
      const allowed = accountIdsKey.split(',')
      if (!payload.new.account_id || !allowed.includes(payload.new.account_id)) {
        return
      }
    }
    onNewMessage?.(payload.new)
  }, [onNewMessage, accountIdsKey])

  useEffect(() => {
    if (!enabled) return

    const supabase = createClient()
    const channel = supabase
      .channel(channelNameRef.current)
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
