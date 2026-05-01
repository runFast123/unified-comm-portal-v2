'use client'

// Client-side rating form for the public CSAT landing page.
// Pure-CSS focus rings + tap targets sized for thumbs (h-14 buttons).

import { useState } from 'react'

const RATINGS: Array<{ value: 1 | 2 | 3 | 4 | 5; emoji: string; label: string }> = [
  { value: 1, emoji: '😡', label: 'Awful' },
  { value: 2, emoji: '😕', label: 'Bad' },
  { value: 3, emoji: '😐', label: 'Okay' },
  { value: 4, emoji: '🙂', label: 'Good' },
  { value: 5, emoji: '😍', label: 'Great' },
]

export function CSATForm({
  token,
  accentColor,
}: {
  token: string
  accentColor: string | null
}) {
  const [selected, setSelected] = useState<1 | 2 | 3 | 4 | 5 | null>(null)
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ rating: number } | null>(null)

  const accent = accentColor || '#0d9488' // teal-600 default

  async function submit() {
    if (!selected) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/csat/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: selected, feedback: feedback.trim() || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || `Submit failed (${res.status})`)
        return
      }
      setDone({ rating: selected })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    const emoji = ['', '😡', '😕', '😐', '🙂', '😍'][done.rating] ?? '🙂'
    return (
      <div className="text-center py-4">
        <div className="text-5xl mb-3">{emoji}</div>
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Thanks!</h2>
        <p className="text-sm text-gray-500">
          We&apos;ve recorded your {done.rating} / 5 rating.
        </p>
      </div>
    )
  }

  return (
    <div>
      <p className="text-sm text-gray-600 text-center mb-5">
        How would you rate this conversation?
      </p>

      <div className="grid grid-cols-5 gap-2 mb-5">
        {RATINGS.map((r) => {
          const isSelected = selected === r.value
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => setSelected(r.value)}
              className={`flex flex-col items-center justify-center h-16 rounded-xl border-2 transition-all ${
                isSelected
                  ? 'shadow-md scale-105'
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              }`}
              style={
                isSelected
                  ? { borderColor: accent, backgroundColor: `${accent}15` }
                  : undefined
              }
              aria-label={`${r.label} (${r.value} of 5)`}
              aria-pressed={isSelected}
            >
              <span className="text-2xl leading-none">{r.emoji}</span>
              <span className="text-[10px] mt-1 text-gray-500 uppercase tracking-wider">
                {r.label}
              </span>
            </button>
          )
        })}
      </div>

      <label className="block text-xs font-medium text-gray-600 mb-1.5">
        Anything else you&apos;d like us to know? <span className="text-gray-400 font-normal">(optional)</span>
      </label>
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        rows={3}
        maxLength={4000}
        placeholder="Tell us what worked, or what we could do better next time."
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent resize-none"
      />

      {error && (
        <p className="mt-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!selected || submitting}
        onClick={submit}
        className="mt-5 w-full h-14 rounded-xl text-white font-semibold text-base transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow-md"
        style={{ backgroundColor: accent }}
      >
        {submitting ? 'Sending…' : selected ? 'Submit rating' : 'Pick a rating'}
      </button>
    </div>
  )
}
