'use client'

// useTimeTracking
// ─────────────────────────────────────────────────────────────────
// Drives a server-side `conversation_time_entries` row for the current
// conversation page. Behavior:
//
//   1. On mount: POST /start, store session_id in a ref.
//   2. Every HEARTBEAT_INTERVAL_MS: POST /heartbeat (skipped while idle).
//   3. On `beforeunload` AND on unmount: POST /end, preferring
//      `navigator.sendBeacon` so it survives tab close.
//   4. Idle detection: any mousemove/keydown/click resets a timer.
//      After IDLE_THRESHOLD_MS with no activity, heartbeats pause.
//      Activity resumes them automatically.
//
// All effects are safe to run in StrictMode — the start request is
// deduplicated via a ref guard, and the cleanup always closes whatever
// session it opened.

import { useEffect, useRef } from 'react'

const HEARTBEAT_INTERVAL_MS = 60 * 1000 // 60s
const IDLE_THRESHOLD_MS = 2 * 60 * 1000 // 2 min

interface Options {
  conversationId: string
  /** When false, the hook is a no-op (lets callers gate by feature flag /
   *  SSR readiness without conditional hook calls). */
  enabled?: boolean
}

export function useTimeTracking({
  conversationId,
  enabled = true,
}: Options): void {
  // We use refs throughout because the cleanup needs to read the latest
  // values without re-binding. State would force unwanted re-renders.
  const sessionIdRef = useRef<string | null>(null)
  const lastActivityRef = useRef<number>(Date.now())
  const startedRef = useRef<boolean>(false)
  const stoppedRef = useRef<boolean>(false)

  useEffect(() => {
    if (!enabled || !conversationId) return
    // StrictMode: this effect runs twice in dev. The startedRef guard
    // prevents firing two /start requests for the same mount cycle.
    if (startedRef.current) return
    startedRef.current = true
    stoppedRef.current = false

    const controller = new AbortController()

    // ── Helpers ────────────────────────────────────────────────────
    const startUrl = `/api/conversations/${encodeURIComponent(conversationId)}/time/start`
    const heartbeatUrl = `/api/conversations/${encodeURIComponent(conversationId)}/time/heartbeat`
    const endUrl = `/api/conversations/${encodeURIComponent(conversationId)}/time/end`

    const recordActivity = () => {
      lastActivityRef.current = Date.now()
    }

    // ── 1. Start the session ───────────────────────────────────────
    void (async () => {
      try {
        const res = await fetch(startUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          credentials: 'same-origin',
          signal: controller.signal,
        })
        if (!res.ok) return
        const body = (await res.json().catch(() => null)) as
          | { session_id?: string }
          | null
        if (body?.session_id) {
          sessionIdRef.current = body.session_id
        }
      } catch {
        // Network issues are best-effort; the GC cron will eventually
        // close any orphaned row anyway.
      }
    })()

    // ── 2. Heartbeat loop ──────────────────────────────────────────
    const heartbeatTimer = window.setInterval(() => {
      const sid = sessionIdRef.current
      if (!sid) return
      // Pause heartbeats when idle — GC will reap us if the user stays
      // away long enough, which is the desired behavior.
      const idleMs = Date.now() - lastActivityRef.current
      if (idleMs > IDLE_THRESHOLD_MS) return
      void fetch(heartbeatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid }),
        credentials: 'same-origin',
        // Don't abort heartbeats — they're fire-and-forget.
        keepalive: true,
      }).catch(() => {
        // Swallow — server-side GC is the safety net.
      })
    }, HEARTBEAT_INTERVAL_MS)

    // ── 3. Activity listeners ──────────────────────────────────────
    const events: Array<keyof WindowEventMap> = [
      'mousemove',
      'mousedown',
      'keydown',
      'scroll',
      'touchstart',
      'click',
    ]
    for (const ev of events) {
      window.addEventListener(ev, recordActivity, { passive: true })
    }

    // ── 4. End-on-unload (sendBeacon for tab close) ────────────────
    const sendEnd = () => {
      if (stoppedRef.current) return
      const sid = sessionIdRef.current
      if (!sid) return
      stoppedRef.current = true
      const payload = JSON.stringify({ session_id: sid })
      try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
          const blob = new Blob([payload], { type: 'application/json' })
          navigator.sendBeacon(endUrl, blob)
          return
        }
      } catch {
        /* fall through */
      }
      // Fallback for environments without sendBeacon — fire-and-forget
      // fetch with keepalive so the browser still flushes it on unload.
      void fetch(endUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        credentials: 'same-origin',
        keepalive: true,
      }).catch(() => {})
    }

    const onBeforeUnload = () => sendEnd()
    const onPageHide = () => sendEnd()
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)

    // ── Cleanup on unmount ─────────────────────────────────────────
    return () => {
      window.clearInterval(heartbeatTimer)
      for (const ev of events) {
        window.removeEventListener(ev, recordActivity)
      }
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
      controller.abort()
      sendEnd()
      startedRef.current = false
      sessionIdRef.current = null
    }
  }, [conversationId, enabled])
}
