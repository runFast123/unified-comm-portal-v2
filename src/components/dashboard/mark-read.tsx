'use client'

import { useEffect } from 'react'
import { markConversationRead } from '@/hooks/useReadStatus'

/** Marks a conversation as read when the component mounts */
export function MarkRead({ conversationId }: { conversationId: string }) {
  useEffect(() => {
    markConversationRead(conversationId)
  }, [conversationId])
  return null
}
