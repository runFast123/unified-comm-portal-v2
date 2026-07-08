'use client'

import { useEffect, useRef, useState } from 'react'
import { Send, CheckCircle2 } from 'lucide-react'

/**
 * Marketing contact / demo-request form. There is no public backend endpoint,
 * so on submit we compose a pre-filled mailto: to the configured contact inbox
 * and open the visitor's mail client. Reliable, zero-infrastructure, and never
 * breaks the build. Swap for a real API route + CRM when one is available.
 */
export function ContactForm({ contactEmail }: { contactEmail: string }) {
  const [sent, setSent] = useState(false)
  const successRef = useRef<HTMLDivElement>(null)

  // Move focus to the confirmation so screen-reader + keyboard users land on
  // the new state (role="status" also announces it politely).
  useEffect(() => {
    if (sent) successRef.current?.focus()
  }, [sent])

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    const name = String(data.get('name') || '').trim()
    const email = String(data.get('email') || '').trim()
    const company = String(data.get('company') || '').trim()
    const size = String(data.get('size') || '').trim()
    const message = String(data.get('message') || '').trim()

    const subject = `Demo request — ${company || name || 'Unified'}`
    const bodyLines = [
      `Name: ${name}`,
      `Work email: ${email}`,
      `Company: ${company}`,
      `Team size: ${size}`,
      '',
      message,
    ]
    const href = `mailto:${contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
      bodyLines.join('\n'),
    )}`
    window.location.href = href
    setSent(true)
  }

  const fieldCls =
    'w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20'

  if (sent) {
    return (
      <div
        ref={successRef}
        role="status"
        tabIndex={-1}
        className="rounded-2xl border border-zinc-200 bg-white p-8 text-center focus:outline-none"
      >
        <CheckCircle2 className="mx-auto h-12 w-12 text-teal-700" />
        <h3 className="mt-4 text-lg font-medium text-zinc-900">Almost there!</h3>
        <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-600">
          Your email app should have opened with your request ready to send. If it didn’t, email us
          directly at{' '}
          <a href={`mailto:${contactEmail}`} className="font-medium text-teal-700 underline">
            {contactEmail}
          </a>
          .
        </p>
        <button
          onClick={() => setSent(false)}
          className="mt-5 text-sm font-medium text-teal-700 hover:underline"
        >
          ← Back to the form
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-zinc-700">
            Name <span className="text-red-600" aria-hidden="true">*</span>
          </label>
          <input id="name" name="name" type="text" required autoComplete="name" className={fieldCls} placeholder="Jane Doe" />
        </div>
        <div>
          <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-zinc-700">
            Work email <span className="text-red-600" aria-hidden="true">*</span>
          </label>
          <input id="email" name="email" type="email" required autoComplete="email" className={fieldCls} placeholder="jane@company.com" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="company" className="mb-1.5 block text-sm font-medium text-zinc-700">
            Company
          </label>
          <input id="company" name="company" type="text" autoComplete="organization" className={fieldCls} placeholder="Acme Inc." />
        </div>
        <div>
          <label htmlFor="size" className="mb-1.5 block text-sm font-medium text-zinc-700">
            Team size
          </label>
          <select id="size" name="size" className={fieldCls} defaultValue="">
            <option value="" disabled>
              Select…
            </option>
            <option>1–5</option>
            <option>6–20</option>
            <option>21–50</option>
            <option>51–200</option>
            <option>200+</option>
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="message" className="mb-1.5 block text-sm font-medium text-zinc-700">
          How can we help?
        </label>
        <textarea
          id="message"
          name="message"
          rows={4}
          className={`${fieldCls} resize-y`}
          placeholder="Tell us about your channels, team and what you’re hoping to improve…"
        />
      </div>
      <button
        type="submit"
        className="group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--brand-accent)] px-6 py-3.5 text-base font-medium text-white transition-colors hover:bg-teal-800 sm:w-auto"
      >
        Send request
        <Send className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </button>
      <p className="text-xs text-zinc-500">
        By submitting, you agree to be contacted about Unified. We’ll never share your details.
      </p>
    </form>
  )
}
