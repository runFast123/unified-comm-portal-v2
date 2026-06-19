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

/** Row shape from public.notifications (RLS scopes SELECT/UPDATE to own rows). */
interface NotificationRow {
  id: string
  type: string | null
  title: string | null
  body: string | null
  link: string | null
  conversation_id: string | null
  read_at: string | null
  created_at: string
}

/** Display model the dropdown renders. `read` is derived from read_at. */
interface NotificationItem {
  id: string
  type: NotificationType
  title: string
  description: string
  timestamp: string
  read: boolean
  conversationId: string | null
  link: string | null
}

const typeConfig: Record<NotificationType, { icon: React.ElementType; color: string; bg: string }> = {
  new_message: { icon: MessageSquare, color: 'text-blue-600', bg: 'bg-blue-100' },
  ai_reply_ready: { icon: Bot, color: 'text-teal-600', bg: 'bg-teal-100' },
  escalation: { icon: AlertTriangle, color: 'text-orange-600', bg: 'bg-orange-100' },
  system_alert: { icon: Info, color: 'text-purple-600', bg: 'bg-purple-100' },
}

/** Map a raw `type` string to a known NotificationType (default new_message). */
function asNotificationType(t: string | null): NotificationType {
  if (t === 'ai_reply_ready' || t === 'escalation' || t === 'system_alert' || t === 'new_message') {
    return t
  }
  return 'new_message'
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

/** Map a DB row to the dropdown display model. */
function toItem(row: NotificationRow): NotificationItem {
  const type = asNotificationType(row.type)
  return {
    id: row.id,
    type,
    // Titles for `new_message` embed the sender name (built server-side from
    // raw sender_name), which can carry `<email>` brackets / wrapping quotes —
    // cleanSenderName strips those for display. Other types have plain titles.
    title: row.title ? cleanSenderName(row.title) : 'Notification',
    description: row.body || '',
    timestamp: row.created_at,
    read: row.read_at != null,
    conversationId: row.conversation_id,
    link: row.link,
  }
}

/** How often to re-poll the persisted table so the badge stays current. */
const POLL_INTERVAL_MS = 45_000

export function NotificationCenter() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(false)
  const [permissionGranted, setPermissionGranted] = useState(false)

  const panelRef = useRef<HTMLDivElement>(null)
  // Guards against setState after unmount (the bell is a hot client component
  // with a poll interval + async fetches in flight on navigation/logout).
  const mountedRef = useRef(true)
  // IDs of unread rows seen in the PRIOR fetch — lets us play the sound only
  // when a genuinely-new unread row appears, not on every poll. `null` until
  // the first fetch completes so the initial load is silent.
  const seenUnreadRef = useRef<Set<string> | null>(null)

  const unreadCount = notifications.filter((n) => !n.read).length

  // Request browser notification permission on mount
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission === 'granted') {
      setPermissionGranted(true)
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((perm) => {
        if (mountedRef.current) setPermissionGranted(perm === 'granted')
      })
    }
  }, [])

  const fetchNotifications = useCallback(async () => {
    if (mountedRef.current) setLoading(true)
    try {
      const supabase = createClient()

      // RLS restricts SELECT to the caller's own rows (user_id = auth.uid()),
      // so no manual user filter is required. We still resolve the user id and
      // add a defensive .eq('user_id', …) so a future RLS change can't widen
      // this feed cross-user.
      const { data: { user } } = await supabase.auth.getUser()

      let query = supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30)
      if (user?.id) query = query.eq('user_id', user.id)

      const { data, error } = await query
      if (error) {
        console.error('Failed to fetch notifications:', error.message)
        return
      }
      if (!mountedRef.current) return

      const rows = (data as NotificationRow[] | null) ?? []
      const items = rows.map(toItem)

      // Sound: only when a genuinely-new UNREAD row appears vs the prior fetch.
      const currentUnreadIds = rows.filter((r) => r.read_at == null).map((r) => r.id)
      const prevSeen = seenUnreadRef.current
      if (prevSeen !== null) {
        const newUnread = currentUnreadIds.filter((id) => !prevSeen.has(id))
        if (newUnread.length > 0) {
          playNotificationSound()
          // Browser push only when the tab isn't focused (mirrors prior behavior).
          if (document.hidden && permissionGranted) {
            const first = items.find((i) => i.id === newUnread[0])
            if (first) {
              try {
                const browserNotif = new window.Notification(first.title, {
                  body: first.description,
                  icon: '/favicon.ico',
                  tag: first.id,
                })
                browserNotif.onclick = () => {
                  window.focus()
                  const dest = first.link || (first.conversationId ? `/conversations/${first.conversationId}` : '/inbox')
                  window.location.href = dest
                  browserNotif.close()
                }
              } catch {
                // Browser notification creation failed
              }
            }
          }
        }
      }
      seenUnreadRef.current = new Set(currentUnreadIds)

      setNotifications(items)
    } catch (err) {
      console.error('Failed to fetch notifications:', err)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [permissionGranted])

  // Initial fetch + lightweight polling. Intentionally NOT Supabase realtime —
  // `notifications` isn't in the realtime publication, so we poll (matches the
  // old fetch-on-open behavior). The interval is cleared on unmount.
  useEffect(() => {
    mountedRef.current = true
    fetchNotifications()
    const t = setInterval(fetchNotifications, POLL_INTERVAL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(t)
    }
  }, [fetchNotifications])

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString()
    // Optimistic: flip locally first so the badge clears instantly.
    setNotifications((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })))
    // Do NOT reset seenUnreadRef here: the just-read ids must stay in the "seen"
    // set so the next poll doesn't re-classify them as new unread (and replay the
    // sound / browser push) in the window before the server UPDATE is visible.
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      // Update only the user's currently-unread rows. RLS scopes UPDATE to own
      // rows; the .is('read_at', null) keeps it to the unread set, and the
      // user_id filter is defensive (mirrors the select).
      let upd = supabase.from('notifications').update({ read_at: now }).is('read_at', null)
      if (user?.id) upd = upd.eq('user_id', user.id)
      await upd
    } catch {
      // Non-critical — the next poll reconciles state from the server.
    }
  }, [])

  const handleNotificationClick = useCallback(
    async (notification: NotificationItem) => {
      setOpen(false)
      // Optimistic local read flip + persist via the browser client (RLS scopes
      // the UPDATE to the caller's own rows).
      if (!notification.read) {
        setNotifications((prev) =>
          prev.map((n) => (n.id === notification.id ? { ...n, read: true } : n))
        )
        // Keep this id in seenUnreadRef (don't delete it): if the read UPDATE
        // hasn't committed when the next poll runs, the row is still "seen" and
        // won't replay the notification sound.
        try {
          const supabase = createClient()
          await supabase
            .from('notifications')
            .update({ read_at: new Date().toISOString() })
            .eq('id', notification.id)
        } catch {
          // Non-critical — next poll reconciles.
        }
      }
      // Navigate: prefer the stored link, fall back to the conversation/inbox.
      if (notification.link) {
        router.push(notification.link)
      } else if (notification.conversationId) {
        router.push(`/conversations/${notification.conversationId}`)
      } else {
        router.push('/inbox')
      }
    },
    [router]
  )

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
                        {notification.description && (
                          <p className="mt-0.5 text-xs text-gray-500 truncate">
                            {notification.description}
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
          const next = !open
          setOpen(next)
          if (next) fetchNotifications()
        }}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {/* Badge anchored to the bell's top-right corner. Was previously
            offset by -top-0.5/-right-0.5 which read as "floating above"
            the bell rather than overlapping it. The ring separates the
            red badge from the bell glyph when they overlap. */}
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white ring-2 ring-white notification-pulse">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Portal-rendered dropdown */}
      {notificationPortal}
    </div>
  )
}
