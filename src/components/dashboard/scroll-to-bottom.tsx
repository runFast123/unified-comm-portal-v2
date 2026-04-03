'use client'

import { useEffect, useRef } from 'react'

/**
 * Invisible element placed at the bottom of a message thread.
 * Auto-scrolls into view on mount and whenever `messageCount` changes.
 */
export function ScrollToBottom({ messageCount }: { messageCount: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const prevCount = useRef(messageCount)

  useEffect(() => {
    // Scroll on initial load and when new messages arrive
    if (ref.current) {
      ref.current.scrollIntoView({ behavior: prevCount.current === 0 ? 'instant' : 'smooth' })
    }
    prevCount.current = messageCount
  }, [messageCount])

  return <div ref={ref} />
}
