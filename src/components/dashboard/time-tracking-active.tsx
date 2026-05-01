'use client'

// Tiny client wrapper that mounts useTimeTracking. Renders nothing —
// it exists so the conversation server-page can include time-tracking
// without forcing the page to convert to "use client" or wrap the
// existing tree.

import { useTimeTracking } from '@/hooks/useTimeTracking'

export function TimeTrackingActive({
  conversationId,
}: {
  conversationId: string
}) {
  useTimeTracking({ conversationId })
  return null
}
