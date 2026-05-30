'use client'

import { useState } from 'react'
import { Send, CheckCircle2 } from 'lucide-react'

/**
 * Marketing contact / demo-request form. There is no public backend endpoint,
 * so on submit we compose a pre-filled mailto: to the configured contact inbox
 * and open the visitor's mail client. Reliable, zero-infrastructure, and never
 * breaks the build. Swap for a real API route + CRM when one is available.
 */
export function ContactForm({ contactEmail }: { contactEmail: string }) {
  const [sent, setSent] = useState(false)

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
    'w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm outline-none transition-colors placeholder:text-gray-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20'

  if (sent) {
    return (
      <div className="rounded-2xl border border-teal-200 bg-teal-50/60 p-8 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-teal-600" />
        <h3 className="mt-4 text-lg font-semibold text-gray-900">Almost there!</h3>
        <p className="mx-auto mt-2 max-w-sm text-sm text-gray-600">
          Your email app should have opened with your request ready to send. If it didn’t, email us
          directly at{' '}
          <a href={`mailto:${contactEmail}`} className="font-semibold text-teal-700 underline">
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
          <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-gray-700">
            Name
          </label>
          <input id="name" name="name" type="text" required autoComplete="name" className={fieldCls} placeholder="Jane Doe" />
        </div>
        <div>
          <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-gray-700">
            Work email
          </label>
          <input id="email" name="email" type="email" required autoComplete="email" className={fieldCls} placeholder="jane@company.com" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="company" className="mb-1.5 block text-sm font-medium text-gray-700">
            Company
          </label>
          <input id="company" name="company" type="text" autoComplete="organization" className={fieldCls} placeholder="Acme Inc." />
        </div>
        <div>
          <label htmlFor="size" className="mb-1.5 block text-sm font-medium text-gray-700">
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
        <label htmlFor="message" className="mb-1.5 block text-sm font-medium text-gray-700">
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
        className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-teal-700 to-teal-600 px-6 py-3.5 text-base font-semibold text-white shadow-lg shadow-teal-700/25 transition-all hover:shadow-xl sm:w-auto"
      >
        Send request
        <Send className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </button>
      <p className="text-xs text-gray-400">
        By submitting, you agree to be contacted about Unified. We’ll never share your details.
      </p>
    </form>
  )
}
