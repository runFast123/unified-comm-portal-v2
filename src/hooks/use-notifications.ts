'use client'

import { useEffect, useCallback, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase-client'

export interface BrowserNotification {
  id: string
  type: 'new_message'
  senderName: string
  subject: string
  bodyPreview: string
  channel: string
  conversationId: string | null
  accountName: string | null
  timestamp: string
  read: boolean
}

interface UseNotificationsOptions {
  enabled?: boolean
}

/**
 * Hook that:
 * 1. Requests browser notification permission on mount
 * 2. Subscribes to Supabase realtime on the 'messages' table (INSERT, inbound)
 * 3. Shows browser Notification when tab is hidden
 * 4. Plays a subtle notification sound
 * 5. Stores last 20 notifications in state
 */
export function useNotifications({ enabled = true }: UseNotificationsOptions = {}) {
  const [notifications, setNotifications] = useState<BrowserNotification[]>([])
  const [permissionGranted, setPermissionGranted] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const unreadCount = notifications.filter((n) => !n.read).length

  // Request notification permission on mount
  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined' || !('Notification' in window)) return

    if (Notification.permission === 'granted') {
      setPermissionGranted(true)
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((perm) => {
        setPermissionGranted(perm === 'granted')
      })
    }
  }, [enabled])

  // Create a subtle notification sound using AudioContext
  const playNotificationSound = useCallback(() => {
    try {
      const ctx = new AudioContext()
      const oscillator = ctx.createOscillator()
      const gainNode = ctx.createGain()

      oscillator.connect(gainNode)
      gainNode.connect(ctx.destination)

      oscillator.frequency.setValueAtTime(587.33, ctx.currentTime) // D5
      oscillator.frequency.setValueAtTime(783.99, ctx.currentTime + 0.1) // G5
      oscillator.type = 'sine'

      gainNode.gain.setValueAtTime(0.1, ctx.currentTime)
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4)

      oscillator.start(ctx.currentTime)
      oscillator.stop(ctx.currentTime + 0.4)
    } catch {
      // Audio not supported, silently ignore
    }
  }, [])

  // Mark a notification as read
  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    )
  }, [])

  // Mark all as read
  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
  }, [])

  // Handle new message from realtime
  const handleNewMessage = useCallback(
    (payload: any) => {
      const msg = payload.new
      if (!msg || msg.direction !== 'inbound') return

      const cleanSender = (msg.sender_name || 'Unknown')
        .replace(/<[^>]+>/g, '')
        .replace(/^["']+|["']+$/g, '')
        .trim() || 'Unknown'

      const subject = msg.email_subject || ''
      const bodyPreview = (msg.message_text || '').slice(0, 100)

      const notification: BrowserNotification = {
        id: `rt-${msg.id}-${Date.now()}`,
        type: 'new_message',
        senderName: cleanSender,
        subject,
        bodyPreview,
        channel: msg.channel || 'email',
        conversationId: msg.conversation_id || null,
        accountName: null, // Would require a join, so we leave it null
        timestamp: msg.received_at || new Date().toISOString(),
        read: false,
      }

      // Add to state (keep last 20)
      setNotifications((prev) => [notification, ...prev].slice(0, 20))

      // Play sound
      playNotificationSound()

      // Show browser notification only if tab is hidden
      if (document.hidden && permissionGranted) {
        const title = `New message from ${cleanSender}`
        const body = subject ? `${subject}\n${bodyPreview}` : bodyPreview
        try {
          const browserNotif = new Notification(title, {
            body,
            icon: '/favicon.ico',
            tag: `msg-${msg.id}`,
          })
          browserNotif.onclick = () => {
            window.focus()
            if (msg.conversation_id) {
              window.location.href = `/conversations/${msg.conversation_id}`
            }
            browserNotif.close()
          }
        } catch {
          // Browser notification failed, ignore
        }
      }
    },
    [permissionGranted, playNotificationSound]
  )

  // Subscribe to Supabase realtime
  useEffect(() => {
    if (!enabled) return

    const supabase = createClient()
    const channel = supabase
      .channel('browser-notifications')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: 'direction=eq.inbound',
        },
        handleNewMessage
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [enabled, handleNewMessage])

  return {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    permissionGranted,
  }
}
