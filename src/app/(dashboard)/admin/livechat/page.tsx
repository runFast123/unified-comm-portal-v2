'use client'

import { useEffect, useState } from 'react'

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
        <div className="rounded-xl border bg-white p-8 text-center">
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
          <section className="rounded-xl border bg-white p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Embed snippet</h2>
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={widget.is_enabled}
                  onChange={(e) => save({ is_enabled: e.target.checked })}
                  disabled={saving}
                />
                {widget.is_enabled ? 'Live' : 'Disabled'}
              </label>
            </div>
            <p className="mt-1 text-sm text-gray-500">Paste this just before <code>&lt;/body&gt;</code> on every page.</p>
            <div className="mt-3 flex items-stretch gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg bg-gray-900 px-3 py-2.5 text-xs text-gray-100">{snippet}</code>
              <button
                onClick={copySnippet}
                className="shrink-0 rounded-lg border border-gray-300 px-3 text-sm font-medium hover:bg-gray-50"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
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
