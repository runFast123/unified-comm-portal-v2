'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Bookmark, BookmarkCheck, X, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'

const STORAGE_KEY = 'conversation-bookmarks'

function getBookmarks(): { id: string; title: string; account: string; time: string }[] {
  if (typeof window === 'undefined') return []
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}

function saveBookmarks(bookmarks: { id: string; title: string; account: string; time: string }[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks))
}

/** Bookmark toggle button for a conversation */
export function BookmarkButton({ conversationId, participantName, accountName }: {
  conversationId: string; participantName: string; accountName: string
}) {
  const [isBookmarked, setIsBookmarked] = useState(false)

  useEffect(() => {
    setIsBookmarked(getBookmarks().some(b => b.id === conversationId))
  }, [conversationId])

  const toggle = useCallback(() => {
    const bookmarks = getBookmarks()
    if (isBookmarked) {
      saveBookmarks(bookmarks.filter(b => b.id !== conversationId))
      setIsBookmarked(false)
    } else {
      bookmarks.unshift({ id: conversationId, title: participantName, account: accountName, time: new Date().toISOString() })
      saveBookmarks(bookmarks.slice(0, 20))
      setIsBookmarked(true)
    }
  }, [conversationId, participantName, accountName, isBookmarked])

  return (
    <button
      onClick={toggle}
      className={cn('p-1 rounded-md transition-colors', isBookmarked ? 'text-amber-500 hover:text-amber-600' : 'text-gray-400 hover:text-amber-500')}
      title={isBookmarked ? 'Remove bookmark' : 'Bookmark this conversation'}
    >
      {isBookmarked ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
    </button>
  )
}

/** Bookmarks panel — shows all bookmarked conversations */
export function BookmarksPanel() {
  const [bookmarks, setBookmarks] = useState<{ id: string; title: string; account: string; time: string }[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setBookmarks(getBookmarks())
  }, [open])

  const remove = (id: string) => {
    const updated = getBookmarks().filter(b => b.id !== id)
    saveBookmarks(updated)
    setBookmarks(updated)
  }

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className={cn('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
          open ? 'bg-amber-100 text-amber-700' : 'text-gray-600 hover:bg-gray-100'
        )}
      >
        <Bookmark className="h-4 w-4" />
        Bookmarks
        {bookmarks.length > 0 && (
          <span className="rounded-full bg-amber-200 text-amber-800 px-1.5 py-0 text-xs font-bold">{bookmarks.length}</span>
        )}
      </button>

      {open && bookmarks.length > 0 && (
        <div className="absolute right-0 top-full mt-1 w-80 rounded-xl bg-white border border-gray-200 shadow-xl z-30 max-h-80 overflow-y-auto">
          <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-600">Bookmarked Conversations</span>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600"><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="divide-y divide-gray-50">
            {bookmarks.map(b => (
              <div key={b.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 transition-colors">
                <MessageSquare className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                <Link href={`/conversations/${b.id}`} className="flex-1 min-w-0" onClick={() => setOpen(false)}>
                  <p className="text-sm font-medium text-gray-800 truncate">{b.title}</p>
                  <p className="text-[10px] text-gray-400">{b.account}</p>
                </Link>
                <button onClick={() => remove(b.id)} className="text-gray-300 hover:text-red-500 shrink-0"><X className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
