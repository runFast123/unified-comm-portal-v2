'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  Bell,
  MessageSquare,
  Bot,
  AlertTriangle,
  Info,
  Check,
  X,
} from 'lucide-react'
import { createClient } from '@/lib/supabase-client'
import { cn } from '@/lib/utils'

type NotificationType = 'new_message' | 'ai_reply_ready' | 'escalation' | 'system_alert'

interface Notification {
  id: string
  type: NotificationType
  title: string
  description: string
  timestamp: string
  read: boolean
  conversationId?: string | null
  senderName?: string | null
  companyName?: string | null
}

const typeConfig: Record<NotificationType, { icon: React.ElementType; color: string; bg: string }> = {
  new_message: { icon: MessageSquare, color: 'text-blue-600', bg: 'bg-blue-100' },
  ai_reply_ready: { icon: Bot, color: 'text-teal-600', bg: 'bg-teal-100' },
  escalation: { icon: AlertTriangle, color: 'text-orange-600', bg: 'bg-orange-100' },
  system_alert: { icon: Info, color: 'text-purple-600', bg: 'bg-purple-100' },
}

function timeAgo(dateStr: string): string {
  const now = new Date()
  const date = new Date(dateStr)
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

function cleanSenderName(name: string | null): string {
  return (name || 'Unknown').replace(/<[^>]+>/g, '').replace(/^["']+|["']+$/g, '').trim() || 'Unknown'
}

/** Play a subtle two-tone notification sound using Web Audio API */
function playNotificationSound() {
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
    // Audio not supported
  }
}

export function NotificationCenter() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(false)
  const [permissionGranted, setPermissionGranted] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const unreadCount = notifications.filter((n) => !n.read).length

  // Request browser notification permission on mount
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission === 'granted') {
      setPermissionGranted(true)
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((perm) => {
        setPermissionGranted(perm === 'granted')
      })
    }
  }, [])

  const fetchNotifications = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()

      // Fetch recent inbound messages as "new_message" notifications
      const { data: messages } = await supabase
        .from('messages')
        .select('id, conversation_id, sender_name, email_subject, message_text, channel, received_at, replied')
        .eq('direction', 'inbound')
        .order('received_at', { ascending: false })
        .limit(10)

      // Fetch recent AI replies as "ai_reply_ready" notifications
      const { data: aiReplies } = await supabase
        .from('ai_replies')
        .select('id, message_id, status, created_at, channel, messages!ai_replies_message_id_fkey(conversation_id, sender_name)')
        .in('status', ['pending_approval', 'edited'])
        .order('created_at', { ascending: false })
        .limit(10)

      const items: Notification[] = []

      // Build message notifications
      ;(messages || []).forEach((msg: any) => {
        const sender = cleanSenderName(msg.sender_name)
        items.push({
          id: `msg-${msg.id}`,
          type: 'new_message',
          title: `New ${msg.channel} message`,
          description: `${sender}: ${(msg.email_subject || msg.message_text || '').slice(0, 60)}`,
          timestamp: msg.received_at,
          read: msg.replied === true,
          conversationId: msg.conversation_id,
          senderName: sender,
        })
      })

      // Build AI reply notifications
      ;(aiReplies || []).forEach((reply: any) => {
        const linked = reply.messages as any
        const sender = cleanSenderName(linked?.sender_name)
        items.push({
          id: `ai-${reply.id}`,
          type: 'ai_reply_ready',
          title: 'AI draft ready for review',
          description: `Reply for ${sender} via ${reply.channel}`,
          timestamp: reply.created_at,
          read: false,
          conversationId: linked?.conversation_id || null,
          senderName: sender,
        })
      })

      // Sort by timestamp desc
      items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

      setNotifications(items.slice(0, 20))
    } catch (err) {
      console.error('Failed to fetch notifications:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchNotifications()
  }, [fetchNotifications])

  // Subscribe to realtime message inserts for browser push notifications
  useEffect(() => {
    const supabase = createClient()

    const channel = supabase
      .channel('notification-center-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: 'direction=eq.inbound',
        },
        (payload: any) => {
          const msg = payload.new
          if (!msg || msg.direction !== 'inbound') return

          const sender = cleanSenderName(msg.sender_name)
          const subject = msg.email_subject || ''
          const bodyPreview = (msg.message_text || '').slice(0, 60)

          // Add to notification list (prepend, keep 20)
          const newNotif: Notification = {
            id: `rt-${msg.id}-${Date.now()}`,
            type: 'new_message',
            title: `New ${msg.channel || 'email'} message`,
            description: `${sender}: ${subject || bodyPreview}`,
            timestamp: msg.received_at || new Date().toISOString(),
            read: false,
            conversationId: msg.conversation_id || null,
            senderName: sender,
          }

          setNotifications((prev) => [newNotif, ...prev].slice(0, 20))

          // Play notification sound
          playNotificationSound()

          // Show browser notification only when tab is not focused
          if (document.hidden && permissionGranted) {
            try {
              const browserNotif = new window.Notification(
                `New message from ${sender}`,
                {
                  body: subject ? `${subject}\n${bodyPreview}` : bodyPreview,
                  icon: '/favicon.ico',
                  tag: `msg-${msg.id}`,
                }
              )
              browserNotif.onclick = () => {
                window.focus()
                if (msg.conversation_id) {
                  window.location.href = `/conversations/${msg.conversation_id}`
                }
                browserNotif.close()
              }
            } catch {
              // Browser notification creation failed
            }
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [permissionGranted])

  const markAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
  }

  const handleNotificationClick = (notification: Notification) => {
    // Mark as read
    setNotifications((prev) =>
      prev.map((n) => (n.id === notification.id ? { ...n, read: true } : n))
    )
    setOpen(false)
    // Navigate to conversation if available
    if (notification.conversationId) {
      router.push(`/conversations/${notification.conversationId}`)
    } else {
      router.push('/inbox')
    }
  }

  const notificationPortal = open && typeof document !== 'undefined'
    ? createPortal(
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          {/* Panel */}
          <div className="fixed top-14 right-6 w-80 sm:w-96 rounded-xl border border-gray-200 bg-white shadow-2xl z-[9999] overflow-hidden" style={{ maxHeight: 'calc(100vh - 80px)' }}>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-900">Notifications</h3>
                {unreadCount > 0 && (
                  <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-100 px-1.5 text-xs font-semibold text-red-600">
                    {unreadCount}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-teal-600 hover:bg-teal-50 transition-colors"
                  >
                    <Check className="h-3 w-3" />
                    Mark all read
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Notification List */}
            <div className="max-h-[50vh] overflow-y-auto">
              {loading && notifications.length === 0 ? (
                <div className="py-8 text-center text-sm text-gray-400">
                  Loading notifications...
                </div>
              ) : notifications.length === 0 ? (
                <div className="py-8 text-center text-sm text-gray-400">
                  No notifications yet
                </div>
              ) : (
                notifications.map((notification) => {
                  const config = typeConfig[notification.type]
                  const Icon = config.icon
                  return (
                    <button
                      key={notification.id}
                      onClick={() => handleNotificationClick(notification)}
                      className={cn(
                        'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50',
                        !notification.read && 'bg-blue-50/50'
                      )}
                    >
                      <div className={cn('mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg', config.bg)}>
                        <Icon className={cn('h-4 w-4', config.color)} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className={cn(
                            'text-sm truncate',
                            notification.read
                              ? 'text-gray-700'
                              : 'font-semibold text-gray-900'
                          )}>
                            {notification.title}
                          </p>
                          {!notification.read && (
                            <span className="flex-shrink-0 h-2 w-2 rounded-full bg-blue-500" />
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-gray-500 truncate">
                          {notification.description}
                        </p>
                        {notification.senderName && (
                          <p className="mt-0.5 text-[11px] text-gray-400 truncate">
                            {notification.senderName}
                            {notification.companyName ? ` - ${notification.companyName}` : ''}
                          </p>
                        )}
                        <p className="mt-0.5 text-[11px] text-gray-400">
                          {timeAgo(notification.timestamp)}
                        </p>
                      </div>
                    </button>
                  )
                })
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-gray-100 px-4 py-2">
              <button
                onClick={() => {
                  setOpen(false)
                  router.push('/inbox')
                }}
                className="w-full rounded-md py-1.5 text-center text-xs font-medium text-teal-600 hover:bg-teal-50 transition-colors"
              >
                View all in Inbox
              </button>
            </div>
          </div>
        </>,
        document.body
      )
    : null

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell Button */}
      <button
        onClick={() => {
          setOpen(!open)
          if (!open) fetchNotifications()
        }}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white notification-pulse">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Portal-rendered dropdown */}
      {notificationPortal}
    </div>
  )
}
