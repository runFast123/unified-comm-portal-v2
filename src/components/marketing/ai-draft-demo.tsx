'use client'

import { useState } from 'react'
import { Bot, Check, Pencil, RefreshCw } from 'lucide-react'

const MONO = 'font-[family-name:var(--font-geist-mono)]'

const DRAFTS = [
  'Hi Ava, I’m so sorry your order arrived damaged. I’ve issued a full refund to your original payment method — you’ll see it within 3–5 business days. I’ve also emailed a prepaid return label. Anything else I can help with?',
  'Hi Ava — really sorry about the damage. Your full refund is on its way (3–5 business days), and a prepaid return label is already in your inbox. Anything else I can do for you?',
  'So sorry to hear your order arrived damaged, Ava. I’ve gone ahead and refunded you in full — it’ll be back on your card within 3–5 business days — and sent a prepaid return label to your email. Let me know if there’s anything else.',
]

/**
 * Interactive "AI drafts, you decide" demo. The visitor can Regenerate (cycle
 * tone variants, with a brief generating shimmer), Edit the draft inline, and
 * Approve & send (→ a sent confirmation, then start over). Reduced motion skips
 * the generating delay. Light Console theme.
 */
export function AiDraftDemo() {
  const [idx, setIdx] = useState(0)
  const [text, setText] = useState(DRAFTS[0])
  const [editing, setEditing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [sent, setSent] = useState(false)

  const regenerate = () => {
    if (generating) return
    const next = (idx + 1) % DRAFTS.length
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      setIdx(next)
      setText(DRAFTS[next])
      return
    }
    setGenerating(true)
    window.setTimeout(() => {
      setIdx(next)
      setText(DRAFTS[next])
      setGenerating(false)
    }, 650)
  }

  const reset = () => {
    setSent(false)
    setEditing(false)
    setGenerating(false)
    setIdx(0)
    setText(DRAFTS[0])
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5">
      <div className={`${MONO} flex items-center justify-between text-[12px] text-teal-700`}>
        <span className="inline-flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5" /> suggested reply
        </span>
        {!sent && <span className="text-[10px] text-zinc-400">draft {idx + 1}/{DRAFTS.length}</span>}
      </div>

      {sent ? (
        <div className="mt-3">
          <div className="flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 p-3 text-sm font-medium text-teal-700">
            <Check className="h-4 w-4 shrink-0" /> Sent — Ava will get your reply.
          </div>
          <button
            type="button"
            onClick={reset}
            className="mt-3 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-800"
          >
            ← Try another draft
          </button>
        </div>
      ) : generating ? (
        <div className="mt-3" aria-live="polite">
          <div className={`${MONO} mb-2.5 inline-flex items-center gap-1.5 text-[11px] text-teal-700`}>
            <RefreshCw className="h-3 w-3 animate-spin" /> generating…
          </div>
          <div className="space-y-2">
            <div className="h-2.5 w-[92%] animate-pulse rounded bg-zinc-200" />
            <div className="h-2.5 w-full animate-pulse rounded bg-zinc-200" />
            <div className="h-2.5 w-[78%] animate-pulse rounded bg-zinc-200" />
          </div>
        </div>
      ) : editing ? (
        <div className="mt-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            aria-label="Edit the AI draft"
            className="w-full resize-none rounded-lg border border-zinc-300 bg-white p-2.5 text-sm leading-relaxed text-zinc-800 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
          />
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-teal-700"
          >
            <Check className="h-3.5 w-3.5" /> Done editing
          </button>
        </div>
      ) : (
        <>
          <p className="mt-3 text-sm leading-relaxed text-zinc-700">{text}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSent(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-teal-700"
            >
              <Check className="h-3.5 w-3.5" /> Approve &amp; send
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-zinc-50"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit draft
            </button>
            <button
              type="button"
              onClick={regenerate}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-zinc-50"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Regenerate
            </button>
          </div>
        </>
      )}
    </div>
  )
}
