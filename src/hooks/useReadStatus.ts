'use client'

const STORAGE_KEY = 'conversation-read-status'

function getStore(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveStore(store: Record<string, string>) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

/** Mark a conversation as read at the current time */
export function markConversationRead(conversationId: string) {
  const store = getStore()
  store[conversationId] = new Date().toISOString()
  saveStore(store)
}

/** Check if a conversation has unread messages (message newer than last read) */
export function isUnread(conversationId: string, latestMessageTime: string | null): boolean {
  if (!latestMessageTime) return false
  const store = getStore()
  const lastRead = store[conversationId]
  if (!lastRead) return true // Never opened = unread
  return new Date(latestMessageTime).getTime() > new Date(lastRead).getTime()
}
