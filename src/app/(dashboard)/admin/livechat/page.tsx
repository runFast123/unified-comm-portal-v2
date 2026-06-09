'use client'

import { useEffect, useState } from 'react'
import { Copy, Check, Code2 } from 'lucide-react'

interface Widget {
  id: string
  account_id: string
  widget_key: string
  title: string
  color: string
  welcome_message: string
  is_enabled: boolean
}

export default function LiveChatAdminPage() {
  const [widget, setWidget] = useState<Widget | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [origin, setOrigin] = useState('')

  // editable form state
  const [title, setTitle] = useState('')
  const [color, setColor] = useState('#16a34a')
  const [welcome, setWelcome] = useState('')

  useEffect(() => {
    setOrigin(window.location.origin)
    void load()
  }, [])

  function sync(w: Widget | null) {
    setWidget(w)
    if (w) {
      setTitle(w.title)
      setColor(w.color)
      setWelcome(w.welcome_message)
    }
  }

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/admin/livechat')
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Failed to load')
      sync(d.widget)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  async function enable() {
    setSaving(true)
    setError(null)
    try {
      const r = await fetch('/api/admin/livechat', { method: 'POST' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Failed to enable')
      sync(d.widget)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enable')
    } finally {
      setSaving(false)
    }
  }

  async function save(patch: Partial<Pick<Widget, 'title' | 'color' | 'welcome_message' | 'is_enabled'>>) {
    setSaving(true)
    setError(null)
    try {
      const r = await fetch('/api/admin/livechat', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Failed to save')
      sync(d.widget)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const snippet = widget
    ? `<script src="${origin}/api/widget/loader?key=${widget.widget_key}" async></script>`
    : ''

  function copySnippet() {
    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Live Chat</h1>
        <p className="mt-1 text-sm text-gray-500">
          Add a chat bubble to your website. Conversations land in your inbox as a Live Chat channel.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : !widget ? (
        <div className="animate-slide-up rounded-xl border bg-white p-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
            <span className="text-2xl">💬</span>
          </div>
          <h2 className="text-lg font-semibold text-gray-900">Enable live chat</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
            Create your widget and get a one-line snippet to paste on your site.
          </p>
          <button
            onClick={enable}
            disabled={saving}
            className="mt-4 rounded-lg bg-green-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-60"
          >
            {saving ? 'Enabling…' : 'Enable Live Chat'}
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Embed snippet */}
          <section className="animate-slide-up overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-green-50 text-green-600 ring-1 ring-green-100">
                  <Code2 className="h-[18px] w-[18px]" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Embed code</h2>
                  <p className="text-xs text-gray-500">
                    Paste once, just before{' '}
                    <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] text-gray-700">&lt;/body&gt;</code>
                  </p>
                </div>
              </div>
              {/* live toggle */}
              <button
                type="button"
                role="switch"
                aria-checked={widget.is_enabled}
                onClick={() => save({ is_enabled: !widget.is_enabled })}
                disabled={saving}
                title={widget.is_enabled ? 'Live — click to disable' : 'Disabled — click to go live'}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${widget.is_enabled ? 'bg-green-500' : 'bg-gray-300'}`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${widget.is_enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
                />
              </button>
            </div>

            {/* terminal-style code block with syntax highlighting */}
            <div className="bg-[#0d1117]">
              <div className="flex items-center justify-between px-4 pb-2 pt-3.5">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                  <span className="ml-2 font-mono text-[11px] text-gray-500">index.html</span>
                </div>
                <button
                  onClick={copySnippet}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-all ${
                    copied ? 'bg-green-500/20 text-green-300' : 'bg-white/10 text-gray-200 hover:bg-white/20'
                  }`}
                >
                  {copied ? <><Check className="h-3.5 w-3.5" /> Copied!</> : <><Copy className="h-3.5 w-3.5" /> Copy</>}
                </button>
              </div>
              <pre className="overflow-x-auto px-4 pb-4 text-[13px] leading-relaxed">
                <code className="font-mono">
                  <span className="text-[#ff7b72]">&lt;script</span>{' '}
                  <span className="text-[#79c0ff]">src</span>
                  <span className="text-gray-500">=</span>
                  <span className="text-[#a5d6ff]">&quot;{origin}/api/widget/loader?key={widget.widget_key}&quot;</span>{' '}
                  <span className="text-[#79c0ff]">async</span>
                  <span className="text-[#ff7b72]">&gt;&lt;/script&gt;</span>
                </code>
              </pre>
            </div>

            {/* status footer */}
            <div className="flex items-center gap-2 px-5 py-3 text-xs">
              <span className={`inline-flex h-2 w-2 rounded-full ${widget.is_enabled ? 'bg-green-500' : 'bg-gray-300'}`} />
              <span className="text-gray-500">
                {widget.is_enabled
                  ? 'Your widget is live and accepting chats.'
                  : 'Your widget is disabled — toggle it on to go live.'}
              </span>
            </div>
          </section>

          {/* Appearance */}
          <section className="rounded-xl border bg-white p-5">
            <h2 className="font-semibold text-gray-900">Appearance</h2>
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Header title</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={80}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Accent color</label>
                <div className="mt-1 flex items-center gap-3">
                  <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 rounded border" />
                  <input
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    className="w-32 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Welcome message</label>
                <textarea
                  value={welcome}
                  onChange={(e) => setWelcome(e.target.value)}
                  maxLength={500}
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <button
                onClick={() => save({ title, color, welcome_message: welcome })}
                disabled={saving}
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save appearance'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
