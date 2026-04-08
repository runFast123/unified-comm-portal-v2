'use client'

import { useState, useEffect } from 'react'
import { Sparkles, FileText, Loader2, Check } from 'lucide-react'

interface SuggestedRepliesProps {
  conversationId: string
  latestMessage: string | null
  category: string | null
}

export function SuggestedReplies({ conversationId, latestMessage, category }: SuggestedRepliesProps) {
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([])
  const [templates, setTemplates] = useState<{ id: string; title: string; content: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [inserted, setInserted] = useState<string | null>(null)

  const handleInsert = (text: string) => {
    // Find the manual reply textarea and insert text directly
    const textarea = document.querySelector('textarea[placeholder*="Type your reply"]') as HTMLTextAreaElement | null
    if (textarea) {
      textarea.value = text
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      // Also trigger React's onChange by setting nativeInputValueSetter
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (nativeSetter) {
        nativeSetter.call(textarea, text)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      }
      textarea.focus()
      setInserted(text)
      setTimeout(() => setInserted(null), 2000)
    } else {
      // Textarea not visible — trigger Manual Reply to open first, then copy
      // Click the Manual Reply button
      const manualBtn = document.querySelector('button')
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        if (btn.textContent?.includes('Manual Reply')) {
          btn.click()
          // Wait for textarea to appear, then insert
          setTimeout(() => {
            const ta = document.querySelector('textarea[placeholder*="Type your reply"]') as HTMLTextAreaElement | null
            if (ta) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
              if (setter) {
                setter.call(ta, text)
                ta.dispatchEvent(new Event('input', { bubbles: true }))
              }
              ta.focus()
            }
          }, 300)
          setInserted(text)
          setTimeout(() => setInserted(null), 2000)
          return
        }
      }
      // Last fallback: copy to clipboard
      navigator.clipboard.writeText(text)
      setInserted(text)
      setTimeout(() => setInserted(null), 2000)
    }
  }

  useEffect(() => {
    if (!latestMessage || loaded) return
    setLoading(true)
    fetch('/api/suggest-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId, message_text: latestMessage, category }),
    })
      .then(res => res.json())
      .then(data => {
        setAiSuggestions(data.ai_suggestions || [])
        setTemplates(data.templates || [])
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
      .finally(() => setLoading(false))
  }, [conversationId, latestMessage, category, loaded])

  if (!latestMessage) return null
  if (!loading && aiSuggestions.length === 0 && templates.length === 0) return null

  return (
    <div className="shrink-0 border-t border-gray-100 bg-gray-50/50 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2 pb-1">
        {loading && (
          <div className="flex items-center gap-1.5 text-xs text-gray-400 shrink-0">
            <Loader2 className="h-3 w-3 animate-spin" />
            Generating suggestions...
          </div>
        )}

        {aiSuggestions.map((s, i) => (
          <button
            key={`ai-${i}`}
            onClick={() => handleInsert(s)}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs text-teal-700 hover:bg-teal-100 active:bg-teal-200 transition-colors max-w-[280px]"
            title={`Click to insert: ${s}`}
          >
            {inserted === s ? <Check className="h-3 w-3 shrink-0 text-green-600" /> : <Sparkles className="h-3 w-3 shrink-0" />}
            <span className="truncate">{s.substring(0, 70)}{s.length > 70 ? '...' : ''}</span>
          </button>
        ))}

        {templates.map((t) => (
          <button
            key={`t-${t.id}`}
            onClick={() => handleInsert(t.content)}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs text-purple-700 hover:bg-purple-100 active:bg-purple-200 transition-colors max-w-[220px]"
            title={`Click to insert: ${t.content.substring(0, 100)}`}
          >
            {inserted === t.content ? <Check className="h-3 w-3 shrink-0 text-green-600" /> : <FileText className="h-3 w-3 shrink-0" />}
            <span className="truncate">{t.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
