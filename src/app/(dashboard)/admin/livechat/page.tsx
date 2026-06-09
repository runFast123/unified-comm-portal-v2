'use client'

import { useEffect, useState } from 'react'
import { Copy, Check, Code2, MessagesSquare, ExternalLink } from 'lucide-react'

interface BusinessHours {
  tz: string
  days: string[]
  open: string
  close: string
}

interface Widget {
  id: string
  account_id: string
  widget_key: string
  title: string
  color: string
  welcome_message: string
  subtitle: string
  launcher_text: string
  position: string
  prechat_enabled: boolean
  business_hours_enabled: boolean
  business_hours: BusinessHours | null
  offline_message: string
  is_enabled: boolean
}

interface Stats {
  totalConversations: number
  conversationsThisWeek: number
  openConversations: number
  inboundMessages: number
  outboundMessages: number
  recent: { id: string; name: string; status: string; at: string | null }[]
  dailyVolume: { date: string; count: number }[]
}

const OPEN_STATUSES = new Set(['active', 'in_progress', 'waiting_on_customer', 'escalated'])

const PRESETS = ['#16a34a', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#111827']

/** Readable text color (dark/light) for a given accent — mirrors the widget's contrast(). */
function readableText(hex: string): string {
  const h = (hex || '').replace('#', '')
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(f.slice(0, 2), 16), g = parseInt(f.slice(2, 4), 16), b = parseInt(f.slice(4, 6), 16)
  if (Number.isNaN(r)) return '#fff'
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#111827' : '#fff'
}

const DAY_LIST: [string, string][] = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']]
const COMMON_TZ = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland']

/** Client mirror of the server's isWidgetOnline — drives the "Open/Closed now" badge. */
function clientOnline(days: string[], open: string, close: string, tz: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date())
    const wd = (parts.find((p) => p.type === 'weekday')?.value || '').toLowerCase().slice(0, 3)
    const hh = Number(parts.find((p) => p.type === 'hour')?.value || '0') % 24
    const mm = Number(parts.find((p) => p.type === 'minute')?.value || '0')
    if (!days.includes(wd)) return false
    const cur = hh * 60 + mm
    const [oh, om] = open.split(':').map(Number)
    const [ch, cm] = close.split(':').map(Number)
    const o = oh * 60 + om, c = ch * 60 + cm
    if (c <= o) return cur >= o || cur < c
    return cur >= o && cur < c
  } catch {
    return true
  }
}

function timeAgo(iso: string | null): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function LiveChatAdminPage() {
  const [widget, setWidget] = useState<Widget | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [origin, setOrigin] = useState('')

  // editable form state
  const [title, setTitle] = useState('')
  const [color, setColor] = useState('#16a34a')
  const [welcome, setWelcome] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [launcherText, setLauncherText] = useState('')
  const [position, setPosition] = useState<'left' | 'right'>('right')
  const [prechat, setPrechat] = useState(false)
  const [bhEnabled, setBhEnabled] = useState(false)
  const [bhDays, setBhDays] = useState<string[]>(['mon', 'tue', 'wed', 'thu', 'fri'])
  const [bhOpen, setBhOpen] = useState('09:00')
  const [bhClose, setBhClose] = useState('17:00')
  const [bhTz, setBhTz] = useState('UTC')
  const [offlineMessage, setOfflineMessage] = useState('')

  useEffect(() => {
    setOrigin(window.location.origin)
    try { setBhTz(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') } catch { /* keep UTC */ }
    void load()
  }, [])

  function sync(w: Widget | null) {
    setWidget(w)
    if (w) {
      setTitle(w.title)
      setColor(w.color)
      setWelcome(w.welcome_message)
      setSubtitle(w.subtitle || '')
      setLauncherText(w.launcher_text || '')
      setPosition(w.position === 'left' ? 'left' : 'right')
      setPrechat(!!w.prechat_enabled)
      setBhEnabled(!!w.business_hours_enabled)
      setOfflineMessage(w.offline_message || '')
      const bh = w.business_hours
      if (bh) {
        if (Array.isArray(bh.days)) setBhDays(bh.days)
        if (bh.open) setBhOpen(bh.open)
        if (bh.close) setBhClose(bh.close)
        if (bh.tz) setBhTz(bh.tz)
      }
    }
  }

  async function loadStats() {
    try {
      const r = await fetch('/api/admin/livechat/stats')
      const d = await r.json()
      if (r.ok) setStats(d.stats)
    } catch {
      /* non-critical */
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
      if (d.widget) void loadStats()
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
      void loadStats()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enable')
    } finally {
      setSaving(false)
    }
  }

  async function save(patch: Partial<Pick<Widget, 'title' | 'color' | 'welcome_message' | 'subtitle' | 'launcher_text' | 'position' | 'prechat_enabled' | 'business_hours_enabled' | 'business_hours' | 'offline_message' | 'is_enabled'>>) {
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

  const volMax = stats ? Math.max(...stats.dailyVolume.map((d) => d.count), 1) : 1
  const fg = readableText(color)
  const currentlyOnline = clientOnline(bhDays, bhOpen, bhClose, bhTz)

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
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
            <MessagesSquare className="h-6 w-6 text-green-600" />
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
          {/* ── Report / chat activity ── */}
          {stats && (
            <section className="animate-slide-up overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Chat activity</h2>
                  <p className="text-xs text-gray-500">Your live-chat performance at a glance.</p>
                </div>
                <a
                  href="/inbox"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-green-600 hover:underline"
                >
                  Open inbox <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>

              {/* stat cells */}
              <div className="grid grid-cols-2 sm:grid-cols-4">
                <Stat label="Total chats" value={stats.totalConversations} />
                <Stat label="This week" value={stats.conversationsThisWeek} />
                <Stat label="Open now" value={stats.openConversations} accent="amber" />
                <Stat label="Messages" value={stats.inboundMessages + stats.outboundMessages} />
              </div>

              {/* 14-day sparkline */}
              <div className="border-t border-gray-100 px-5 py-4">
                <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
                  <span>New chats · last 14 days</span>
                  <span className="tabular-nums">{stats.dailyVolume.reduce((s, d) => s + d.count, 0)} total</span>
                </div>
                <div className="flex items-end gap-1" style={{ height: 44 }}>
                  {stats.dailyVolume.map((d) => (
                    <div
                      key={d.date}
                      title={`${d.date}: ${d.count} chat${d.count === 1 ? '' : 's'}`}
                      className="flex-1 rounded-t bg-green-400/80 transition-all hover:bg-green-500"
                      style={{ height: `${Math.max((d.count / volMax) * 100, 4)}%` }}
                    />
                  ))}
                </div>
              </div>

              {/* recent chats */}
              {stats.recent.length > 0 && (
                <div className="border-t border-gray-100 px-5 py-4">
                  <p className="mb-2 text-xs font-medium text-gray-500">Recent chats</p>
                  <ul className="space-y-1">
                    {stats.recent.map((c) => (
                      <li key={c.id}>
                        <a
                          href={`/conversations/${c.id}`}
                          className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-gray-50"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${OPEN_STATUSES.has(c.status) ? 'bg-green-500' : 'bg-gray-300'}`}
                            />
                            <span className="truncate text-sm text-gray-700">{c.name}</span>
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-gray-400">{timeAgo(c.at)}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* ── Settings (left) + Live preview (right) ── */}
          <div className="grid gap-6 lg:grid-cols-5">
            <div className="space-y-6 lg:col-span-3">
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
              <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <h2 className="text-sm font-semibold text-gray-900">Appearance</h2>
                <p className="text-xs text-gray-500">Make the widget match your brand — changes show in the live preview.</p>
                <div className="mt-4 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Header title</label>
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      maxLength={80}
                      placeholder="Chat with us"
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Subtitle <span className="font-normal text-gray-400">· optional</span>
                    </label>
                    <input
                      value={subtitle}
                      onChange={(e) => setSubtitle(e.target.value)}
                      maxLength={120}
                      placeholder="We typically reply in a few minutes"
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Accent color</label>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {PRESETS.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setColor(p)}
                          title={p}
                          aria-label={`Use ${p}`}
                          className={`h-7 w-7 rounded-full ring-2 ring-offset-1 transition ${color.toLowerCase() === p ? 'ring-gray-900' : 'ring-transparent hover:ring-gray-300'}`}
                          style={{ backgroundColor: p }}
                        />
                      ))}
                    </div>
                    <div className="mt-2.5 flex items-center gap-3">
                      <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 rounded border" />
                      <input
                        value={color}
                        onChange={(e) => setColor(e.target.value)}
                        className="w-32 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm uppercase"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Launcher label <span className="font-normal text-gray-400">· optional</span>
                    </label>
                    <input
                      value={launcherText}
                      onChange={(e) => setLauncherText(e.target.value)}
                      maxLength={40}
                      placeholder="Need help?"
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                    <p className="mt-1 text-xs text-gray-400">A small label shown next to the chat bubble.</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Position</label>
                    <div className="mt-1.5 inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
                      {(['left', 'right'] as const).map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setPosition(p)}
                          className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${position === p ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                        >
                          Bottom {p}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Welcome message</label>
                    <textarea
                      value={welcome}
                      onChange={(e) => setWelcome(e.target.value)}
                      maxLength={500}
                      rows={2}
                      placeholder="Hi! How can we help you today?"
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <button
                    onClick={() => save({ title, color, welcome_message: welcome, subtitle, launcher_text: launcherText, position })}
                    disabled={saving}
                    className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-60"
                  >
                    {saving ? 'Saving…' : 'Save appearance'}
                  </button>
                </div>
              </section>

              {/* Pre-chat form (lead capture) */}
              <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold text-gray-900">Pre-chat form</h2>
                    <p className="mt-0.5 text-xs text-gray-500">
                      Ask visitors for their name &amp; email before they start chatting — captures leads and lets you follow up by email.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={prechat}
                    onClick={() => { setPrechat(!prechat); void save({ prechat_enabled: !prechat }) }}
                    disabled={saving}
                    title={prechat ? 'On — click to turn off' : 'Off — click to turn on'}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${prechat ? 'bg-green-500' : 'bg-gray-300'}`}
                  >
                    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${prechat ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                  </button>
                </div>
              </section>

              {/* Business hours / offline mode */}
              <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold text-gray-900">Business hours</h2>
                    <p className="mt-0.5 text-xs text-gray-500">
                      Outside your hours the widget shows an away message — visitors can still leave a message you can reply to by email.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={bhEnabled}
                    onClick={() => setBhEnabled(!bhEnabled)}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${bhEnabled ? 'bg-green-500' : 'bg-gray-300'}`}
                  >
                    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${bhEnabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                  </button>
                </div>

                {bhEnabled && (
                  <div className="mt-4 space-y-4 border-t border-gray-100 pt-4">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${currentlyOnline ? 'bg-green-50 text-green-700 ring-green-200' : 'bg-gray-100 text-gray-600 ring-gray-200'}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${currentlyOnline ? 'bg-green-500' : 'bg-gray-400'}`} />
                        {currentlyOnline ? 'Open now' : 'Closed now'}
                      </span>
                      <span className="text-xs text-gray-400">based on the schedule below</span>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700">Timezone</label>
                      <select value={bhTz} onChange={(e) => setBhTz(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                        {(COMMON_TZ.includes(bhTz) ? COMMON_TZ : [bhTz, ...COMMON_TZ]).map((tz) => (
                          <option key={tz} value={tz}>{tz}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700">Open days</label>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {DAY_LIST.map(([k, label]) => {
                          const on = bhDays.includes(k)
                          return (
                            <button
                              key={k}
                              type="button"
                              onClick={() => setBhDays(on ? bhDays.filter((d) => d !== k) : [...bhDays, k])}
                              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${on ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                            >
                              {label}
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    <div className="flex items-end gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Open</label>
                        <input type="time" value={bhOpen} onChange={(e) => setBhOpen(e.target.value)} className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                      </div>
                      <div className="pb-2.5 text-gray-400">—</div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Close</label>
                        <input type="time" value={bhClose} onChange={(e) => setBhClose(e.target.value)} className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700">Away message</label>
                      <textarea
                        value={offlineMessage}
                        onChange={(e) => setOfflineMessage(e.target.value)}
                        maxLength={500}
                        rows={2}
                        placeholder="Thanks for reaching out! We're away right now — leave your message and we'll reply by email."
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                )}

                <div className="mt-4">
                  <button
                    onClick={() => save({ business_hours_enabled: bhEnabled, business_hours: { tz: bhTz, days: bhDays, open: bhOpen, close: bhClose }, offline_message: offlineMessage })}
                    disabled={saving}
                    className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-60"
                  >
                    {saving ? 'Saving…' : 'Save business hours'}
                  </button>
                </div>
              </section>
            </div>

            {/* Live preview */}
            <div className="lg:col-span-2">
              <section className="lg:sticky lg:top-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <h2 className="text-sm font-semibold text-gray-900">Live preview</h2>
                <p className="text-xs text-gray-500">Updates as you edit — this is what visitors see.</p>
                <div className="mt-4 rounded-xl border border-gray-200 bg-gradient-to-b from-gray-50 to-gray-100 p-4">
                  {/* mock chat window */}
                  <div className="mx-auto max-w-[260px] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg">
                    <div className="flex items-center justify-between gap-2 px-4 py-3" style={{ backgroundColor: color, color: fg }}>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-tight">{title || 'Chat with us'}</div>
                        {subtitle && <div className="truncate text-[11px] leading-tight opacity-85">{subtitle}</div>}
                      </div>
                      <span className="shrink-0 opacity-80">×</span>
                    </div>
                    {prechat ? (
                      <div className="space-y-2 bg-gray-50 px-3 py-3.5">
                        <div className="text-xs font-semibold text-gray-700">Before we start</div>
                        <div className="-mt-1 text-[11px] leading-snug text-gray-400">Tell us who you are so we can help.</div>
                        <div className="mt-1 rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-[11px] text-gray-400">Your name</div>
                        <div className="rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-[11px] text-gray-400">Email address</div>
                        <div className="mt-0.5 rounded-lg px-2.5 py-2 text-center text-[11px] font-semibold" style={{ backgroundColor: color, color: fg }}>
                          Start chat
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="space-y-2 bg-gray-50 px-3 py-3">
                          <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-gray-100 bg-white px-3 py-2 text-xs text-gray-700">
                            {welcome || 'Hi! How can we help you today?'}
                          </div>
                          <div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm px-3 py-2 text-xs" style={{ backgroundColor: color, color: fg }}>
                            Is this in stock?
                          </div>
                        </div>
                        <div className="flex items-center gap-2 border-t border-gray-100 px-3 py-2.5">
                          <div className="flex-1 truncate rounded-full border border-gray-200 px-3 py-1.5 text-xs text-gray-400">
                            Type a message…
                          </div>
                          <div className="rounded-full px-2.5 py-1.5 text-[11px] font-semibold" style={{ backgroundColor: color, color: fg }}>
                            Send
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                  {/* mock launcher bubble (+ optional label) — position-aware */}
                  <div className={`mt-3 flex items-center gap-2 ${position === 'left' ? 'flex-row-reverse justify-start' : 'justify-end'}`}>
                    {launcherText && (
                      <span className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-sm">
                        {launcherText}
                      </span>
                    )}
                    <div className="flex h-12 w-12 items-center justify-center rounded-full shadow-lg" style={{ backgroundColor: color, color: fg }}>
                      <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                        <path d="M12 3C6.5 3 2 6.6 2 11c0 2.1 1 4 2.7 5.4-.1 1.2-.6 2.4-1.5 3.3 1.6-.2 3.1-.8 4.3-1.7 1.4.5 2.9.8 4.5.8 5.5 0 10-3.6 10-8s-4.5-8-10-8z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: 'amber' }) {
  return (
    <div className="border-b border-r border-gray-100 px-5 py-4 last:border-r-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums tracking-tight ${accent === 'amber' && value > 0 ? 'text-amber-600' : 'text-gray-900'}`}>
        {value.toLocaleString()}
      </p>
    </div>
  )
}
