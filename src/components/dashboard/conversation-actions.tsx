'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { MacroRunner } from '@/components/dashboard/macro-runner'
import { getChannel } from '@/lib/channels/registry'
import {
  CheckCircle,
  CheckCheck,
  Pencil,
  MessageSquare,
  AlertTriangle,
  UserPlus,
  Send,
  X,
  Loader2,
  FileText,
  ChevronDown,
  Search,
  Info,
  Eye,
  Clock,
  Paperclip,
  RotateCcw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase-client'
import { useToast } from '@/components/ui/toast'
import { useConversationPresence } from '@/hooks/useConversationPresence'
import { useSmartCompose } from '@/hooks/useSmartCompose'
import { useUser } from '@/context/user-context'
import { isSupervisor } from '@/lib/roles'
import type { ReplyTemplate } from '@/types/database'
import { substituteTemplate as substituteTemplateVars } from '@/lib/templates'
import { resolveInboxNavTarget } from '@/lib/inbox-nav'

// Roles that may NOT take any write action on a conversation. Mirrors the
// "viewer" notion in the user_role enum — read-only seats. The active role
// catalogue (super_admin / company_admin / company_member) all retain full
// write privileges.
const READ_ONLY_ROLES = new Set(['viewer'])

const SMART_COMPOSE_STORAGE_KEY = 'smart-compose-enabled'

interface ConversationActionsProps {
  conversationId: string
  accountId: string
  accountName: string
  channel: string
  aiReplyId: string | null
  aiReplyStatus: string | null
  aiDraftText: string | null
  participantEmail: string | null
  participantPhone?: string | null
  participantName?: string | null
  emailSubject: string | null
  teamsChatId?: string | null
  conversationStatus?: string
  /** Current viewer's auth.user.id — used as the presence-channel key. */
  currentUserId?: string | null
  /** Current viewer's display name (full_name or email). */
  currentUserName?: string | null
}

export function ConversationActions({
  conversationId,
  accountId,
  accountName,
  channel,
  aiReplyId,
  aiReplyStatus,
  aiDraftText,
  participantEmail,
  participantPhone,
  participantName,
  emailSubject,
  teamsChatId,
  conversationStatus = 'active',
  currentUserId,
  currentUserName,
}: ConversationActionsProps) {
  // Resolve the reply recipient for THIS channel from the registry: email →
  // participant_email, whatsapp/sms → participant_phone, teams/telegram/
  // messenger/instagram → teams_chat_id. Drives the send guard + payload so
  // EVERY channel is replyable from the composer (not just email/teams).
  const sendRecipient = useMemo<string | null>(() => {
    const field = getChannel(channel)?.recipientField
    if (field === 'participant_email') return participantEmail
    if (field === 'participant_phone') return participantPhone ?? null
    if (field === 'teams_chat_id') return teamsChatId ?? null
    return null
  }, [channel, participantEmail, participantPhone, teamsChatId])
  const router = useRouter()
  const { toast } = useToast()
  const { role: viewerRole, can } = useUser()
  const isReadOnly = READ_ONLY_ROLES.has(viewerRole)
  // Phase 2 gate: `company_member` keeps reply / escalate / resolve but loses
  // medium-trust ops (AI approve, edit-AI-draft). Anything supervisor-or-above
  // sees the full toolbar. The corresponding API routes enforce the same
  // check server-side — this just hides UI we know would 403.
  const canApproveAI = isSupervisor(viewerRole)
  // RBAC gates for the conversation write actions. Defense-in-depth — the
  // server-side routes (status / mark-replied / assign) are the real
  // enforcement, but we also disable the buttons so a within-company user whom
  // an admin restricted (e.g. denied action:message.send via a per-user
  // override in /admin/roles) isn't offered an action that will only 403.
  // `can()` returns true when no permission set is present (provider used
  // outside the dashboard layout), so this never blanks the controls.
  const canSend = can('action:message.send')
  const canAssign = can('action:conversation.assign')
  const [loading, setLoading] = useState<string | null>(null)

  // ── Realtime presence: who else is viewing this conversation ────────
  // We pass an empty user_id when the page hasn't supplied one — the hook
  // bails out internally and `others` stays empty so nothing breaks.
  const { others: presenceOthers, setComposing } = useConversationPresence(
    conversationId,
    {
      user_id: currentUserId || '',
      display_name: currentUserName || 'Agent',
      avatar_url: null,
    }
  )
  const composingOthers = presenceOthers.filter((u) => u.composing)

  // POST to a guarded per-conversation route. Routes the detail-view write
  // actions through the same server-side RBAC / channel gates (and audit /
  // CSAT / webhook side-effects) the inbox bulk actions use, instead of writing
  // the conversations / messages tables directly from the browser Supabase
  // client. The conversations/messages UPDATE RLS is intentionally only
  // company+channel scoped, so a restricted within-company user could otherwise
  // still mutate from here. Resolves the parsed error message for the toast.
  const postConversationAction = useCallback(
    async (path: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch(`/api/conversations/${conversationId}/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (res.ok) return { ok: true }
        let error = `HTTP ${res.status}`
        try {
          const j = await res.json()
          if (j?.error) error = j.error
        } catch { /* non-JSON */ }
        return { ok: false, error }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    [conversationId]
  )

  // Helper: after a reply is sent, flip the conversation to waiting_on_customer
  // and mark its inbound messages replied. Routed through the guarded /status +
  // /mark-replied routes (both gated by action:message.send) rather than direct
  // table writes. Best-effort — the caller just sent (so it holds message.send),
  // and a hiccup here must never surface as an error after a successful send.
  const markWaitingOnCustomer = useCallback(async () => {
    await postConversationAction('status', { status: 'waiting_on_customer' })
    await postConversationAction('mark-replied', {})
  }, [postConversationAction])
  const isActiveConvo = conversationStatus === 'active' || conversationStatus === 'in_progress' || conversationStatus === 'escalated' || conversationStatus === 'waiting_on_customer'
  // Composer starts CLOSED so the message thread is the hero on load. An open
  // composer (textarea + signature + action bar) consumes ~280px and, stacked
  // under the suggested-replies block, used to squeeze the actual conversation
  // off-screen — the user had to Cancel the composer just to read the chat.
  // The user opens it explicitly via "Manual Reply" (or by clicking a suggested
  // reply, which opens it automatically). `isActiveConvo` still gates whether
  // the reply controls render at all.
  const [showManualReply, setShowManualReply] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [showEditReply, setShowEditReply] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const draftTimerRef = useRef<NodeJS.Timeout | null>(null)
  const typingPingRef = useRef(0)
  const sendReplyRef = useRef<(() => void) | null>(null)

  // Start empty so SSR output matches the first client render. The saved
  // draft is hydrated in the effect below to avoid a hydration mismatch.
  const [manualText, setManualText] = useState('')
  const [editText, setEditText] = useState(aiDraftText || '')

  // Schedule-send modal state
  const [showScheduleModal, setShowScheduleModal] = useState(false)
  const [scheduledFor, setScheduledFor] = useState<string>('') // datetime-local string
  const [scheduling, setScheduling] = useState(false)

  // ── Failed sends ─────────────────────────────────────────────────────
  // Replies that died AFTER the undo window (cron dispatch failed). Without
  // this banner the failure is invisible: no timeline row exists and the
  // customer never got the reply.
  type FailedSend = {
    id: string
    kind: 'pending_send' | 'scheduled'
    channel: string
    body_preview: string
    error: string | null
    failed_at: string
    to_address: string | null
  }
  const [failedSends, setFailedSends] = useState<FailedSend[]>([])
  const [failedActionId, setFailedActionId] = useState<string | null>(null)
  const failedRecheckRef = useRef<NodeJS.Timeout | null>(null)

  const fetchFailedSends = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/scheduled-messages?conversation_id=${encodeURIComponent(conversationId)}&include=failed`,
        { cache: 'no-store' }
      )
      if (!res.ok) return
      const json = await res.json()
      setFailedSends(Array.isArray(json.failed) ? json.failed : [])
    } catch { /* banner is best-effort — never block the composer */ }
  }, [conversationId])

  useEffect(() => {
    fetchFailedSends()
    return () => {
      if (failedRecheckRef.current) clearTimeout(failedRecheckRef.current)
    }
  }, [fetchFailedSends])

  // After queueing a send the cron dispatches within ~60s; re-check once
  // past that window so a failure surfaces while the agent is still here.
  const scheduleFailedRecheck = useCallback(() => {
    if (failedRecheckRef.current) clearTimeout(failedRecheckRef.current)
    failedRecheckRef.current = setTimeout(() => { void fetchFailedSends() }, 90_000)
  }, [fetchFailedSends])

  const handleFailedAction = useCallback(
    async (item: FailedSend, op: 'retry' | 'dismiss') => {
      setFailedActionId(item.id)
      try {
        const res = await fetch('/api/scheduled-messages/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id, kind: item.kind, op }),
        })
        if (!res.ok) {
          let msg = ''
          try {
            const j = await res.json()
            msg = j?.error ? ` (${j.error})` : ''
          } catch { /* non-JSON */ }
          throw new Error(`${op === 'retry' ? 'Retry' : 'Dismiss'} failed${msg}`)
        }
        setFailedSends((prev) => prev.filter((x) => x.id !== item.id))
        if (op === 'retry') {
          toast.success('Reply re-queued — sending within a minute')
          scheduleFailedRecheck()
        }
      } catch (err) {
        toast.error((err as Error).message)
      } finally {
        setFailedActionId(null)
      }
    },
    [toast, scheduleFailedRecheck]
  )

  // ── Email signature toggle (email channel only) ─────────────────────
  // Defaults ON — matches the server-side default for `append_signature`.
  // Persisted in localStorage so we don't keep nagging an agent who
  // turned it off intentionally. Email-only — Teams/WhatsApp ignore it.
  const SIG_TOGGLE_KEY = 'append-signature-enabled'
  const [appendSignature, setAppendSignature] = useState(true)
  // Resolved signature shown inline (faded) under the textarea so the
  // agent can see what'll be appended before sending. Loaded once per
  // conversation; fetch is throttled to email-channel composers.
  const [resolvedSignature, setResolvedSignature] = useState<string | null>(null)
  const [signatureLoaded, setSignatureLoaded] = useState(false)

  // Outbound attachments (email-only for now). Uploaded to Supabase Storage
  // via /api/attachments/upload before the reply is sent.
  type PendingAttachment = {
    path: string
    filename: string
    contentType: string
    size: number
    url: string
  }
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [uploadingAttachments, setUploadingAttachments] = useState(false)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const isEmailChannel = channel === 'email'

  const formatBytes = useCallback((n: number): string => {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }, [])

  const handleAttachmentPick = useCallback(() => {
    if (!isEmailChannel) {
      toast.warning('Attachments are only supported for Email right now')
      return
    }
    attachmentInputRef.current?.click()
  }, [isEmailChannel, toast])

  const handleAttachmentFiles = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : []
      // Reset the input so picking the same file twice still fires onChange.
      if (attachmentInputRef.current) attachmentInputRef.current.value = ''
      if (files.length === 0) return

      setUploadingAttachments(true)
      try {
        const fd = new FormData()
        fd.append('conversation_id', conversationId)
        for (const f of files) fd.append('file', f)

        const res = await fetch('/api/attachments/upload', { method: 'POST', body: fd })
        if (!res.ok) {
          let errMsg = 'Upload failed'
          try {
            const j = await res.json()
            if (j?.error) errMsg = j.error
          } catch { /* non-JSON */ }
          toast.error(errMsg)
          return
        }
        const data = (await res.json()) as { uploaded: PendingAttachment[] }
        setPendingAttachments((prev) => [...prev, ...(data.uploaded || [])])
      } catch (err) {
        toast.error(`Upload failed: ${(err as Error).message}`)
      } finally {
        setUploadingAttachments(false)
      }
    },
    [conversationId, toast]
  )

  const handleRemoveAttachment = useCallback(
    (path: string) => {
      setPendingAttachments((prev) => prev.filter((a) => a.path !== path))
      // Fire-and-forget cleanup from storage.
      fetch('/api/attachments/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      }).catch(() => { /* non-critical */ })
    },
    []
  )

  // Narrow, JSON-friendly attachment payload to send to /api/send.
  const attachmentsForSend = useCallback(
    () => pendingAttachments.map((a) => ({
      path: a.path,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    })),
    [pendingAttachments]
  )

  // Re-usable chip strip rendered above Send/Schedule controls.
  const AttachmentChips = useCallback(() => {
    if (pendingAttachments.length === 0 && !uploadingAttachments) return null
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {pendingAttachments.map((a) => (
          <span
            key={a.path}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-50 text-zinc-700 px-2.5 py-1 text-xs ring-1 ring-zinc-200"
          >
            <Paperclip size={11} className="text-zinc-500" />
            <span className="max-w-[14rem] truncate">{a.filename}</span>
            <span className="tabular-nums text-zinc-500">{formatBytes(a.size)}</span>
            <button
              type="button"
              onClick={() => handleRemoveAttachment(a.path)}
              className="ml-0.5 rounded hover:bg-zinc-200 text-zinc-500 hover:text-zinc-700"
              aria-label={`Remove ${a.filename}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {uploadingAttachments && (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 text-zinc-700 px-2.5 py-1 text-xs ring-1 ring-zinc-200">
            <Loader2 size={11} className="animate-spin" />
            Uploading…
          </span>
        )}
      </div>
    )
  }, [pendingAttachments, uploadingAttachments, formatBytes, handleRemoveAttachment])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const saved = localStorage.getItem(`draft-${conversationId}`)
    if (saved) setManualText(saved)
  }, [conversationId])

  // Template variable interpolation. Supports both legacy single-segment
  // tokens ({{customer_name}}) and the new dotted form ({{customer.name}}).
  // We run the dotted-form substitution first so the legacy regex can't
  // accidentally swallow `{{customer.name}}` as `{{customer}}` etc.
  const interpolateVars = useCallback((text: string): string => {
    const accountClean = accountName
      .replace(/\s+Teams$/i, '')
      .replace(/\s+WhatsApp$/i, '')
      .trim()
    const withModernVars = substituteTemplateVars(text, {
      customer: {
        name: participantName || null,
        email: participantEmail || null,
      },
      // Fill {{user.full_name}} from the signed-in agent — the composer DOES
      // have this (the currentUserName prop), so agent-name variables resolve
      // instead of rendering empty.
      user: { full_name: currentUserName || null },
      company: { name: accountClean },
      conversation: { subject: emailSubject || null },
    })
    return withModernVars
      .replace(/\{\{customer_name\}\}/gi, participantName || participantEmail || 'Customer')
      .replace(/\{\{account_name\}\}/gi, accountClean)
      .replace(/\{\{email_subject\}\}/gi, emailSubject || '')
      .replace(/\{\{channel\}\}/gi, channel)
  }, [participantName, participantEmail, accountName, emailSubject, channel, currentUserName])

  // Template state
  const [templates, setTemplates] = useState<ReplyTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templateSearch, setTemplateSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')

  // Shortcut autocomplete state
  const [shortcutQuery, setShortcutQuery] = useState<string | null>(null)
  const [shortcutTemplates, setShortcutTemplates] = useState<ReplyTemplate[]>([])
  const [shortcutIndex, setShortcutIndex] = useState(0)
  const [shortcutLoaded, setShortcutLoaded] = useState(false)
  const [allShortcutTemplates, setAllShortcutTemplates] = useState<ReplyTemplate[]>([])
  const manualTextareaRef = useRef<HTMLTextAreaElement>(null)

  // ── Smart Compose (AI ghost-text suggestions) ─────────────────────────
  // Cursor position is tracked separately so the hook knows whether the
  // user is at the end of the textarea (the only spot we suggest).
  // `isSending` (set inside `serverUndoableSend`) gates AI calls so we
  // don't burn tokens on a message that's about to leave.
  const [smartComposeEnabled, setSmartComposeEnabled] = useState<boolean>(true)
  const [cursorPos, setCursorPos] = useState<number>(0)
  const [isSending, setIsSending] = useState<boolean>(false)

  // Hydrate the toggle from localStorage. Default is on; an explicit "false"
  // string means the user disabled it last session.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = localStorage.getItem(SMART_COMPOSE_STORAGE_KEY)
    if (stored === 'false') setSmartComposeEnabled(false)
  }, [])

  const persistSmartComposeEnabled = useCallback((next: boolean) => {
    setSmartComposeEnabled(next)
    try {
      localStorage.setItem(SMART_COMPOSE_STORAGE_KEY, next ? 'true' : 'false')
    } catch { /* localStorage may be unavailable in private mode */ }
  }, [])

  // Hydrate signature toggle from localStorage. Default ON.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = localStorage.getItem(SIG_TOGGLE_KEY)
    if (stored === 'false') setAppendSignature(false)
  }, [])

  const persistAppendSignature = useCallback((next: boolean) => {
    setAppendSignature(next)
    try {
      localStorage.setItem(SIG_TOGGLE_KEY, next ? 'true' : 'false')
    } catch { /* localStorage may be unavailable in private mode */ }
  }, [])

  // Lazy-load the resolved signature so the inline preview matches what the
  // server will append. Only runs for email channels with the composer open
  // — saves a roundtrip for Teams/WhatsApp tabs that don't use it.
  useEffect(() => {
    if (channel !== 'email') return
    if (!showManualReply) return
    if (signatureLoaded) return
    let cancelled = false
    fetch('/api/users/signature')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled) return
        if (json && typeof json.resolved === 'string') {
          setResolvedSignature(json.resolved)
        } else {
          setResolvedSignature(null)
        }
        setSignatureLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setSignatureLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [channel, showManualReply, signatureLoaded])

  const {
    suggestion: smartSuggestion,
    accept: acceptSmartSuggestion,
    dismiss: dismissSmartSuggestion,
  } = useSmartCompose({
    conversationId,
    text: manualText,
    cursorPos,
    enabled: smartComposeEnabled && showManualReply && can('action:ai.compose'),
    isSendInFlight: isSending,
    textareaRef: manualTextareaRef,
  })

  // Fetch templates via the company-scoped API. RLS handles isolation.
  const fetchTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    try {
      const res = await fetch(`/api/templates?account_id=${encodeURIComponent(accountId)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { templates?: ReplyTemplate[] }
      const list = (data.templates ?? []).filter((t) => t.is_active)
      // Pre-sort by usage_count so most-used is on top.
      list.sort((a, b) => (b.usage_count ?? 0) - (a.usage_count ?? 0))
      setTemplates(list)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown'
      console.error('Failed to fetch templates:', msg)
      setTemplates([])
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  // Fetch templates when dropdown opens
  useEffect(() => {
    if (showTemplates) {
      fetchTemplates()
    }
  }, [showTemplates, fetchTemplates])

  // Fetch shortcut templates (templates that have a shortcut defined).
  // Uses the same company-scoped API and filters client-side.
  const fetchShortcutTemplates = useCallback(async () => {
    if (shortcutLoaded) return
    try {
      const res = await fetch(`/api/templates?account_id=${encodeURIComponent(accountId)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { templates?: ReplyTemplate[] }
      const list = (data.templates ?? [])
        .filter((t) => t.is_active && t.shortcut)
        .sort((a, b) => (b.usage_count ?? 0) - (a.usage_count ?? 0))
      setAllShortcutTemplates(list)
      setShortcutLoaded(true)
    } catch (err) {
      console.error('Failed to fetch shortcut templates:', err)
      setAllShortcutTemplates([])
      setShortcutLoaded(true)
    }
  }, [shortcutLoaded])

  // Filter shortcut templates based on query
  useEffect(() => {
    if (shortcutQuery === null) {
      setShortcutTemplates([])
      return
    }
    const q = shortcutQuery.toLowerCase()
    const filtered = allShortcutTemplates.filter((t) => {
      const sc = (t.shortcut || '').toLowerCase().replace(/^\//, '')
      return sc.startsWith(q) || t.title.toLowerCase().includes(q)
    })
    setShortcutTemplates(filtered)
    setShortcutIndex(0)
  }, [shortcutQuery, allShortcutTemplates])

  // Handle textarea change for shortcut detection
  const handleManualTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setManualText(value)

    // Broadcast "composing" presence so other agents see a typing indicator.
    // The hook handles its own 200ms debounce + 5s auto-clear; if the user
    // empties the textarea, drop the flag immediately.
    if (value.trim().length > 0) {
      setComposing(true)
    } else {
      setComposing(false)
    }

    // Auto-save draft to localStorage (debounced)
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      if (value.trim()) {
        localStorage.setItem(`draft-${conversationId}`, value)
        setDraftSaved(true)
        setTimeout(() => setDraftSaved(false), 2000)
      } else {
        localStorage.removeItem(`draft-${conversationId}`)
      }
    }, 500)

    // Live-chat: signal the visitor's widget that the agent is typing (throttled
    // to once per 4s; the widget shows "Agent is typing…" until it goes stale).
    if (channel === 'livechat' && value.trim().length > 0) {
      const nowTs = Date.now()
      if (nowTs - typingPingRef.current > 4000) {
        typingPingRef.current = nowTs
        fetch(`/api/conversations/${conversationId}/typing`, { method: 'POST' }).catch(() => {})
      }
    }

    // Detect "/" shortcut pattern
    const cursorPos = e.target.selectionStart
    setCursorPos(cursorPos)
    const textBeforeCursor = value.substring(0, cursorPos)

    // Space-trigger: if the user just typed `/welcome ` (trailing space)
    // and an exact-match shortcut exists, swap the literal `/welcome ` for
    // the substituted template body. Lets agents skip the popup entirely
    // when they remember the shortcut.
    const justTypedSpace = textBeforeCursor.endsWith(' ')
    const trailingMatch = textBeforeCursor.match(/(?:^|\s)\/([\w][\w-]*) $/)
    if (justTypedSpace && trailingMatch && shortcutLoaded && allShortcutTemplates.length > 0) {
      const wanted = trailingMatch[1].toLowerCase()
      const exact = allShortcutTemplates.find(
        (t) => (t.shortcut || '').replace(/^\//, '').toLowerCase() === wanted
      )
      if (exact) {
        // Replace `/wanted ` with the rendered template content.
        const literal = `/${trailingMatch[1]} `
        const literalStart = textBeforeCursor.lastIndexOf(literal)
        const before = value.substring(0, literalStart)
        const after = value.substring(cursorPos)
        const inserted = interpolateVars(exact.content)
        const newText = before + inserted + after
        setManualText(newText)
        setShortcutQuery(null)
        // Move cursor to just after the inserted content.
        requestAnimationFrame(() => {
          if (manualTextareaRef.current) {
            const newPos = literalStart + inserted.length
            manualTextareaRef.current.selectionStart = newPos
            manualTextareaRef.current.selectionEnd = newPos
            manualTextareaRef.current.focus()
            setCursorPos(newPos)
          }
        })
        // Fire-and-forget: increment usage count.
        try {
          const supabase = createClient()
          void supabase.rpc('increment_template_usage_count', { template_id: exact.id })
        } catch { /* non-critical */ }
        return
      }
    }

    // Find the last "/" that starts a potential shortcut (preceded by start-of-text or whitespace)
    const match = textBeforeCursor.match(/(?:^|\s)\/([\w]*)$/)
    if (match) {
      const query = match[1] // text after "/"
      setShortcutQuery(query)
      if (!shortcutLoaded) {
        fetchShortcutTemplates()
      }
    } else {
      setShortcutQuery(null)
    }
  }, [shortcutLoaded, fetchShortcutTemplates, conversationId, setComposing, allShortcutTemplates, interpolateVars])

  // Handle shortcut selection
  const handleShortcutSelect = useCallback(async (template: ReplyTemplate) => {
    const textarea = manualTextareaRef.current
    if (!textarea) return

    const cursorPos = textarea.selectionStart
    const textBeforeCursor = manualText.substring(0, cursorPos)
    const textAfterCursor = manualText.substring(cursorPos)

    // Find the "/" shortcut text to replace
    const match = textBeforeCursor.match(/(?:^|\s)(\/[\w]*)$/)
    if (match) {
      const shortcutText = match[1]
      const startIndex = textBeforeCursor.lastIndexOf(shortcutText)
      const before = manualText.substring(0, startIndex)
      const newText = before + interpolateVars(template.content) + textAfterCursor
      setManualText(newText)

      // Set cursor position after inserted content
      requestAnimationFrame(() => {
        if (manualTextareaRef.current) {
          const newPos = startIndex + template.content.length
          manualTextareaRef.current.selectionStart = newPos
          manualTextareaRef.current.selectionEnd = newPos
          manualTextareaRef.current.focus()
        }
      })
    }

    setShortcutQuery(null)

    // Increment usage_count
    // NOTE: This uses rpc('increment_usage_count') to avoid race conditions with concurrent users.
    // Fallback to client-side increment if the RPC doesn't exist yet.
    try {
      const supabase = createClient()
      const { error: rpcError } = await supabase.rpc('increment_template_usage_count', { template_id: template.id })
      if (rpcError) {
        // Fallback: race condition possible if multiple users update simultaneously
        await supabase
          .from('reply_templates')
          .update({ usage_count: template.usage_count + 1, updated_at: new Date().toISOString() })
          .eq('id', template.id)
      }
    } catch (err) {
      console.warn('Failed to update template usage count:', err)
    }
  }, [manualText])

  // Handle keyboard navigation in shortcut popup + Ctrl+Enter to send
  const handleManualTextKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ── Smart Compose: Tab to accept ───────────────────────────────────
    // Takes precedence over the default Tab focus jump only when there's
    // a live ghost suggestion AND the shortcut palette isn't open.
    if (
      e.key === 'Tab' &&
      !e.shiftKey &&
      smartSuggestion &&
      shortcutQuery === null
    ) {
      e.preventDefault()
      const merged = acceptSmartSuggestion()
      if (merged != null) {
        setManualText(merged)
        // Move the cursor to the end of the merged text on the next tick.
        requestAnimationFrame(() => {
          const ta = manualTextareaRef.current
          if (!ta) return
          ta.focus()
          ta.selectionStart = merged.length
          ta.selectionEnd = merged.length
          setCursorPos(merged.length)
        })
      }
      return
    }

    // Smart Compose: Escape clears any active ghost text.
    if (e.key === 'Escape' && smartSuggestion) {
      // Don't return — let other Escape handlers (shortcut popup) run too.
      dismissSmartSuggestion()
    }

    // Ctrl+Enter or Cmd+Enter to send reply
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !shortcutQuery) {
      e.preventDefault()
      if (manualText.trim()) sendReplyRef.current?.()
      return
    }

    if (shortcutQuery === null || shortcutTemplates.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setShortcutIndex((prev) => (prev + 1) % shortcutTemplates.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setShortcutIndex((prev) => (prev - 1 + shortcutTemplates.length) % shortcutTemplates.length)
    } else if (e.key === 'Enter' && shortcutTemplates.length > 0) {
      e.preventDefault()
      handleShortcutSelect(shortcutTemplates[shortcutIndex])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setShortcutQuery(null)
    }
  }, [shortcutQuery, shortcutTemplates, shortcutIndex, handleShortcutSelect, manualText, smartSuggestion, acceptSmartSuggestion, dismissSmartSuggestion])

  // Clear draft from localStorage on successful send
  const clearDraft = useCallback(() => {
    localStorage.removeItem(`draft-${conversationId}`)
    setManualText('')
  }, [conversationId])

  // Get unique categories from templates
  const categories = Array.from(
    new Set(templates.map((t) => t.category).filter(Boolean))
  ) as string[]

  // Filter templates
  const filteredTemplates = templates.filter((t) => {
    if (selectedCategory !== 'all' && t.category !== selectedCategory) return false
    if (templateSearch) {
      const search = templateSearch.toLowerCase()
      return (
        t.title.toLowerCase().includes(search) ||
        t.content.toLowerCase().includes(search) ||
        (t.category && t.category.toLowerCase().includes(search))
      )
    }
    return true
  })

  const handleTemplateSelect = useCallback(async (template: ReplyTemplate) => {
    setManualText(interpolateVars(template.content))
    setShowManualReply(true)
    setShowEditReply(false)
    setShowTemplates(false)
    setTemplateSearch('')
    setSelectedCategory('all')

    // Increment usage_count
    // NOTE: This uses rpc('increment_usage_count') to avoid race conditions with concurrent users.
    // Fallback to client-side increment if the RPC doesn't exist yet.
    try {
      const supabase = createClient()
      const { error: rpcError } = await supabase.rpc('increment_template_usage_count', { template_id: template.id })
      if (rpcError) {
        // Fallback: race condition possible if multiple users update simultaneously
        await supabase
          .from('reply_templates')
          .update({ usage_count: template.usage_count + 1, updated_at: new Date().toISOString() })
          .eq('id', template.id)
      }
    } catch (err) {
      console.warn('Failed to update template usage count:', err)
    }
  }, [interpolateVars])

  // ── Server-side Undo-Send helper ────────────────────────────────────
  // Posts the send payload with `delay_ms: 5000` so the server enqueues a
  // `pending_sends` row instead of dispatching immediately. We then show
  // an Undo toast for the same window; clicking Undo calls
  // /api/send/cancel which flips the row to 'cancelled' (no email goes
  // out). After the window expires, the dispatch-scheduled cron picks
  // the row up within ~60s and actually sends it.
  //
  // `onConfirmed` runs only if the user did NOT undo — it's where each
  // handler does its own post-send bookkeeping (e.g. clearing AI reply
  // status, refreshing the route). We intentionally do NOT insert the
  // outbound `messages` row here: the cron does that on dispatch so the
  // timeline reflects what was actually sent (cancelled rows leave no
  // ghost message).
  //
  // `onUndone` runs when the user hits Undo successfully (used to
  // re-populate the textarea so they can edit + resend).
  const UNDO_WINDOW_MS = 5_000
  const serverUndoableSend = useCallback(
    async (
      label: string,
      sendBody: Record<string, unknown>,
      opts: { onConfirmed?: () => void | Promise<void>; onUndone?: () => void } = {}
    ) => {
      // Flip the in-flight flag so Smart Compose stops asking for
      // suggestions on a draft that's about to be sent.
      setIsSending(true)
      try {
        const res = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...sendBody, delay_ms: UNDO_WINDOW_MS }),
        })
        if (!res.ok) {
          let errMsg = ''
          try {
            const j = await res.json()
            errMsg = j?.error ? ` (${j.error})` : ''
          } catch { /* non-JSON */ }
          toast.error(`Failed to queue send${errMsg}.`)
          return
        }
        const data = (await res.json()) as { pending_id?: string }
        const pendingId = data.pending_id
        if (!pendingId) {
          // Server didn't honor delay (older callers / bug). Surface it.
          toast.warning('Send queued but no undo available.')
          if (opts.onConfirmed) await opts.onConfirmed()
          return
        }

        let undone = false
        toast.withAction(`${label} — Undo (5s)`, {
          type: 'info',
          duration: UNDO_WINDOW_MS,
          action: {
            label: 'Undo',
            onClick: async (id) => {
              if (undone) return
              undone = true
              toast.dismiss(id)
              try {
                const cancelRes = await fetch('/api/send/cancel', {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ pending_id: pendingId }),
                })
                if (cancelRes.ok) {
                  toast.warning('Send cancelled')
                  opts.onUndone?.()
                } else if (cancelRes.status === 410) {
                  toast.error('Too late — message was already sent')
                } else {
                  let errMsg = ''
                  try {
                    const j = await cancelRes.json()
                    errMsg = j?.error ? ` (${j.error})` : ''
                  } catch { /* non-JSON */ }
                  toast.error(`Undo failed${errMsg}`)
                }
              } catch (err) {
                toast.error(`Undo failed: ${(err as Error).message}`)
              }
            },
          },
        })

        // The dispatch can still fail at the provider after the undo window
        // closes — re-check the failed-sends banner once that window passes.
        scheduleFailedRecheck()

        // Run post-send bookkeeping immediately. If the user undoes,
        // `onUndone` re-populates the draft. The cron will pick up the
        // row within ~60s if not cancelled.
        if (opts.onConfirmed) {
          // Wait until just past the undo window so we don't trigger
          // any UI side-effects (e.g. router.refresh) that would jank
          // the toast. setTimeout(0) is fine but a small delay keeps
          // the success path tidy.
          setTimeout(() => { void opts.onConfirmed?.() }, UNDO_WINDOW_MS + 50)
        }
      } catch (err) {
        toast.error(`Send failed: ${(err as Error).message}`)
      } finally {
        // Release the in-flight gate so Smart Compose resumes for the
        // NEXT draft. The undo toast handles its own lifecycle independently.
        setIsSending(false)
      }
    },
    [toast, scheduleFailedRecheck]
  )

  const handleApprove = useCallback(async () => {
    if (!aiReplyId) return
    if (!sendRecipient) {
      toast.error('No recipient email address found')
      return
    }
    if (!aiDraftText) {
      toast.error('No AI draft available to send')
      return
    }

    // Snapshot attachments so they survive the undo window. If the user
    // picks more during that window we ignore them for this send.
    const attachmentsSnapshot = isEmailChannel ? attachmentsForSend() : []

    // Optimistically flip the AI reply to 'approved' so the UI gets out of
    // pending_approval. If the user undoes, we revert below.
    const supabase = createClient()
    const reviewedAt = new Date().toISOString()
    await supabase
      .from('ai_replies')
      .update({ status: 'approved', reviewed_at: reviewedAt })
      .eq('id', aiReplyId)

    await serverUndoableSend(
      'AI reply queued',
      {
        channel,
        account_id: accountId,
        conversation_id: conversationId,
        reply_text: aiDraftText,
        to: sendRecipient || undefined,
        subject: emailSubject ? `Re: ${emailSubject}` : 'Re: Your communication',
        teams_chat_id: teamsChatId || undefined,
        attachments: attachmentsSnapshot.length > 0
          ? attachmentsSnapshot.map((a) => ({ path: a.path, filename: a.filename, contentType: a.contentType }))
          : undefined,
      },
      {
        onConfirmed: async () => {
          await supabase
            .from('ai_replies')
            .update({ status: 'sent', sent_at: new Date().toISOString() })
            .eq('id', aiReplyId)
          setPendingAttachments([])
          await markWaitingOnCustomer()
          router.refresh()
        },
        onUndone: () => {
          // Roll the AI reply state back so the user can re-approve / edit.
          void supabase
            .from('ai_replies')
            .update({ status: 'pending_approval', reviewed_at: null })
            .eq('id', aiReplyId)
        },
      }
    )
  }, [aiReplyId, accountId, aiDraftText, conversationId, participantEmail, sendRecipient, router, toast, channel, emailSubject, teamsChatId, markWaitingOnCustomer, serverUndoableSend, isEmailChannel, attachmentsForSend])

  const handleEditSend = useCallback(async () => {
    if (!sendRecipient) {
      toast.error('No recipient email address found')
      return
    }
    if (!editText.trim()) {
      toast.warning('Reply text cannot be empty.')
      return
    }
    const textSnapshot = editText
    const attachmentsSnapshot = isEmailChannel ? attachmentsForSend() : []
    setShowEditReply(false)

    await serverUndoableSend(
      'Edited reply queued',
      {
        channel,
        account_id: accountId,
        conversation_id: conversationId,
        reply_text: textSnapshot,
        to: sendRecipient || undefined,
        subject: emailSubject ? `Re: ${emailSubject}` : 'Re: Your communication',
        teams_chat_id: teamsChatId || undefined,
        attachments: attachmentsSnapshot.length > 0
          ? attachmentsSnapshot.map((a) => ({ path: a.path, filename: a.filename, contentType: a.contentType }))
          : undefined,
      },
      {
        onConfirmed: async () => {
          if (aiReplyId) {
            const supabase = createClient()
            await supabase
              .from('ai_replies')
              .update({
                edited_text: textSnapshot,
                final_text: textSnapshot,
                status: 'sent',
                sent_at: new Date().toISOString(),
              })
              .eq('id', aiReplyId)
          }
          setPendingAttachments([])
          await markWaitingOnCustomer()
          router.refresh()
        },
        onUndone: () => {
          // Re-open the edit panel with the unsent text.
          setEditText(textSnapshot)
          setShowEditReply(true)
        },
      }
    )
  }, [editText, aiReplyId, accountId, participantEmail, sendRecipient, conversationId, router, toast, channel, emailSubject, teamsChatId, markWaitingOnCustomer, serverUndoableSend, isEmailChannel, attachmentsForSend])

  const handleManualReply = useCallback(async () => {
    if (!sendRecipient) {
      toast.error('No recipient email address found')
      return
    }
    if (!manualText.trim()) {
      toast.warning('Reply text cannot be empty.')
      return
    }
    const textSnapshot = manualText
    const attachmentsSnapshot = isEmailChannel ? attachmentsForSend() : []
    // If the user picked attachments on a non-email channel, warn them that
    // they will be ignored but proceed with the text.
    if (!isEmailChannel && pendingAttachments.length > 0) {
      toast.warning('Attachments are only supported for Email — sending text only.')
    }
    // Close textarea + clear draft optimistically. If the user hits Undo,
    // we restore the draft so they can edit/resend.
    setShowManualReply(false)
    clearDraft()

    await serverUndoableSend(
      'Manual reply queued',
      {
        channel,
        account_id: accountId,
        conversation_id: conversationId,
        reply_text: textSnapshot,
        to: sendRecipient || undefined,
        subject: emailSubject ? `Re: ${emailSubject}` : 'Re: Your communication',
        teams_chat_id: teamsChatId || undefined,
        attachments: attachmentsSnapshot.length > 0
          ? attachmentsSnapshot.map((a) => ({ path: a.path, filename: a.filename, contentType: a.contentType }))
          : undefined,
        // Email-only — server ignores this for other channels. Defaults to
        // true on the server; we forward the agent's local toggle so the
        // setting matches what they see in the inline preview.
        append_signature: isEmailChannel ? appendSignature : undefined,
      },
      {
        onConfirmed: async () => {
          // Cron has been notified — the message row will appear in the
          // timeline once dispatch fires. Drop the local attachment chips
          // and refresh so the inbox status updates.
          setPendingAttachments([])
          await markWaitingOnCustomer()
          router.refresh()
        },
        onUndone: () => {
          // Re-open the composer with the unsent text so the user can edit.
          setManualText(textSnapshot)
          setShowManualReply(true)
        },
      }
    )
  }, [manualText, conversationId, accountId, channel, participantEmail, sendRecipient, router, toast, emailSubject, teamsChatId, markWaitingOnCustomer, clearDraft, serverUndoableSend, isEmailChannel, attachmentsForSend, pendingAttachments.length, appendSignature])

  // ── Collision guard ─────────────────────────────────────────────────
  // If another agent is actively typing in this conversation, ask for a
  // soft confirmation before sending. Doesn't block — just pauses for
  // intent. We use the action-toast pattern (Cancel default, Send Anyway
  // continues) so the UX matches the existing Undo flow.
  const requestSendWithCollisionCheck = useCallback(
    (sendFn: () => void) => {
      if (composingOthers.length === 0) {
        sendFn()
        return
      }
      const names = composingOthers.map((u) => u.display_name).join(', ')
      const label = composingOthers.length === 1
        ? `${names} is also composing a reply.`
        : `${names} are also composing a reply.`
      // Clear our own composing flag so we don't show ourselves as a
      // collision against the other agent the moment they confirm.
      setComposing(false)
      toast.withAction(`${label} Send anyway?`, {
        type: 'warning',
        duration: 8000,
        action: {
          label: 'Send Anyway',
          onClick: (id) => {
            toast.dismiss(id)
            sendFn()
          },
        },
      })
    },
    [composingOthers, setComposing, toast]
  )

  const guardedManualReply = useCallback(() => {
    requestSendWithCollisionCheck(() => { void handleManualReply() })
  }, [requestSendWithCollisionCheck, handleManualReply])

  // Keep sendReplyRef updated for Ctrl+Enter shortcut — also routes through
  // the collision guard.
  sendReplyRef.current = guardedManualReply

  // ── Scheduled sends ──────────────────────────────────────────────────
  // datetime-local inputs have no timezone; the browser interprets the
  // value as local time. `new Date(value)` therefore produces the right
  // instant without extra parsing.
  const toLocalDatetimeValue = useCallback((d: Date): string => {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }, [])

  const openScheduleModal = useCallback(() => {
    if (!sendRecipient) {
      toast.error('No recipient email address found')
      return
    }
    if (!manualText.trim()) {
      toast.warning('Type a reply first, then schedule it.')
      return
    }
    // Default: one hour from now, rounded to the nearest minute.
    const d = new Date(Date.now() + 60 * 60 * 1000)
    d.setSeconds(0, 0)
    setScheduledFor(toLocalDatetimeValue(d))
    setShowScheduleModal(true)
  }, [participantEmail, sendRecipient, channel, manualText, toast, toLocalDatetimeValue])

  // Quick-pick helpers
  const applyQuickPick = useCallback((kind: 'in1h' | 'tomorrow9' | 'monday9' | 'nextweek') => {
    const d = new Date()
    if (kind === 'in1h') {
      d.setTime(d.getTime() + 60 * 60 * 1000)
      d.setSeconds(0, 0)
    } else if (kind === 'tomorrow9') {
      d.setDate(d.getDate() + 1)
      d.setHours(9, 0, 0, 0)
    } else if (kind === 'monday9') {
      // 0 = Sunday, 1 = Monday, ...
      const dow = d.getDay()
      const daysUntilMonday = dow === 1 ? 7 : (8 - dow) % 7 || 7
      d.setDate(d.getDate() + daysUntilMonday)
      d.setHours(9, 0, 0, 0)
    } else {
      // Next week, same weekday, 9am
      d.setDate(d.getDate() + 7)
      d.setHours(9, 0, 0, 0)
    }
    setScheduledFor(toLocalDatetimeValue(d))
  }, [toLocalDatetimeValue])

  const handleScheduleSubmit = useCallback(async () => {
    if (!scheduledFor) {
      toast.warning('Pick a date and time.')
      return
    }
    const when = new Date(scheduledFor)
    if (Number.isNaN(when.getTime())) {
      toast.error('Invalid date/time')
      return
    }
    if (when.getTime() <= Date.now() + 60_000) {
      toast.error('Scheduled time must be at least a minute from now.')
      return
    }
    if (!manualText.trim()) {
      toast.warning('Reply text cannot be empty.')
      return
    }

    setScheduling(true)
    try {
      const res = await fetch('/api/scheduled-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          channel,
          reply_text: manualText,
          to: sendRecipient || undefined,
          subject: emailSubject ? `Re: ${emailSubject}` : 'Re: Your communication',
          teams_chat_id: teamsChatId || undefined,
          scheduled_for: when.toISOString(),
        }),
      })
      if (!res.ok) {
        let errMsg = ''
        try {
          const j = await res.json()
          errMsg = j?.error ? ` (${j.error})` : ''
        } catch { /* non-JSON */ }
        throw new Error(`Failed to schedule${errMsg}`)
      }

      const label = when.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
      toast.success(`Scheduled for ${label}`)
      setShowScheduleModal(false)
      clearDraft()
      // Tell the scheduled-messages-list to refresh without a full route reload.
      try {
        window.dispatchEvent(new CustomEvent('scheduled-message-created'))
      } catch { /* older browsers */ }
      router.refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setScheduling(false)
    }
  }, [
    scheduledFor,
    manualText,
    conversationId,
    channel,
    participantEmail,
    emailSubject,
    teamsChatId,
    toast,
    router,
    clearDraft,
  ])

  // Live preview for the schedule modal
  const schedulePreview = (() => {
    if (!scheduledFor) return null
    const when = new Date(scheduledFor)
    if (Number.isNaN(when.getTime())) return null
    const abs = when.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    const diffMs = when.getTime() - Date.now()
    if (diffMs <= 0) return { abs, rel: 'in the past', invalid: true }
    const mins = Math.round(diffMs / 60_000)
    let rel: string
    if (mins < 60) rel = `in ${mins} minute${mins === 1 ? '' : 's'}`
    else if (mins < 60 * 48) {
      const hours = Math.round(mins / 60)
      rel = `in ${hours} hour${hours === 1 ? '' : 's'}`
    } else {
      const days = Math.round(mins / 60 / 24)
      rel = `in ${days} day${days === 1 ? '' : 's'}`
    }
    return { abs, rel, invalid: mins < 1 }
  })()

  // Queue auto-advance shared by Resolve (and Archive via the status dropdown):
  // after the conversation is "done", jump to the next conversation in the
  // inbox order the agent arrived with. Three cases (see resolveInboxNavTarget):
  //   next  → push to the following conversation,
  //   inbox → this was the last in the queue, go back to /inbox,
  //   none  → no queue context, keep the existing refresh-in-place behaviour.
  // Intentionally NOT used by reply-send or Mark-as-Replied.
  const autoAdvanceAfterStatusChange = useCallback(() => {
    const target = resolveInboxNavTarget(conversationId)
    if (target.kind === 'next') router.push(`/conversations/${target.id}`)
    else if (target.kind === 'inbox') router.push('/inbox')
    else router.refresh()
  }, [conversationId, router])

  const handleMarkReplied = useCallback(async () => {
    // Mirror the server gate client-side so the keyboard path is also covered;
    // the buttons are already disabled when !canSend.
    if (!canSend) {
      toast.warning('You do not have permission to update conversations.')
      return
    }
    setLoading('mark_replied')
    try {
      // Mark inbound messages replied via the guarded route (action:message.send
      // + channel access + audit). This is the primary action.
      const replied = await postConversationAction('mark-replied', {})
      if (!replied.ok) throw new Error(replied.error || 'Failed to mark replied')

      // Resolve is secondary — best-effort through the guarded /status route
      // (which also fires CSAT/webhook/audit on resolve). A resolve-permission
      // edge case must not undo the "replied" mark above.
      await postConversationAction('status', { status: 'resolved' })

      toast.success('Marked as replied (replied outside portal)')
      router.refresh()
    } catch (err: any) {
      toast.error('Failed: ' + err.message)
    } finally {
      setLoading(null)
    }
  }, [canSend, postConversationAction, router, toast])

  const handleEscalate = useCallback(async () => {
    if (!canSend) {
      toast.warning('You do not have permission to update conversations.')
      return
    }
    setLoading('escalate')
    try {
      // 1. Status → escalated + priority → urgent in ONE guarded /status call
      //    (the route accepts an optional `priority` and writes the escalation
      //    audit server-side). Enforces action:message.send + channel access.
      //    This is the critical step — abort on failure.
      const statusRes = await postConversationAction('status', {
        status: 'escalated',
        priority: 'urgent',
      })
      if (!statusRes.ok) throw new Error(statusRes.error || 'Failed to escalate')

      // 2. Find a company admin to route the urgent ticket to. Read-only query;
      //    RLS scopes it to the caller's own company. Match the full admin-role
      //    catalogue (modern `company_admin` + legacy `admin`) — hard-coding
      //    'admin' meant escalations on tenants using the modern role names
      //    found nobody.
      const supabase = createClient()
      const { data: adminUser } = await supabase
        .from('users')
        .select('id, email, full_name')
        .in('role', ['company_admin', 'admin'])
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()

      // 3. Auto-assign to that admin THROUGH the guarded /assign route. Assigning
      //    to another user requires action:conversation.assign + supervisor tier
      //    (enforced server-side AND mirrored here), so only attempt it when the
      //    caller qualifies — a member's escalation still flags urgent + notifies
      //    the admin, just without the auto-assign. Best-effort: a failed assign
      //    must not fail the escalation.
      let assigned = false
      if (adminUser && canAssign && isSupervisor(viewerRole)) {
        const assignRes = await postConversationAction('assign', { user_id: adminUser.id })
        assigned = assignRes.ok
      }

      // 4. Send email notification to the admin (guarded route, unchanged).
      if (adminUser?.email) {
        fetch('/api/notifications/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: adminUser.email,
            sender_name: participantEmail || 'Unknown',
            account_name: accountName,
            channel,
            subject: emailSubject || 'Escalated Conversation',
            message_preview: assigned
              ? `This conversation has been escalated to urgent priority and assigned to you.`
              : `This conversation has been escalated to urgent priority.`,
            conversation_id: conversationId,
            priority: 'urgent',
          }),
        }).catch(() => {}) // fire-and-forget
      }

      toast.success(`Conversation escalated!${assigned && adminUser ? ` Assigned to ${adminUser.full_name || adminUser.email}` : ''}`)
      router.refresh()
    } catch (err: any) {
      toast.error('Failed to escalate: ' + err.message)
    } finally {
      setLoading(null)
    }
  }, [canSend, canAssign, viewerRole, postConversationAction, conversationId, accountName, channel, participantEmail, emailSubject, router, toast])

  const handleResolve = useCallback(async () => {
    if (!canSend) {
      toast.warning('You do not have permission to update conversations.')
      return
    }
    setLoading('resolve')
    try {
      // Route through the guarded /status route (action:message.send + channel
      // access; also fires CSAT/webhook/audit on resolve) instead of a direct
      // conversations write.
      const res = await postConversationAction('status', { status: 'resolved' })
      if (!res.ok) throw new Error(res.error || 'Failed to resolve')
      toast.success('Conversation resolved!')
      autoAdvanceAfterStatusChange()
    } catch (err: any) {
      toast.error('Failed to resolve: ' + err.message)
    } finally {
      setLoading(null)
    }
    // `router` is reached via autoAdvanceAfterStatusChange, not directly here.
  }, [canSend, postConversationAction, toast, autoAdvanceAfterStatusChange])

  // Global keyboard shortcuts for conversation actions
  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      // Ctrl+. (or Cmd+.) toggles Smart Compose. We allow this from inside
      // INPUT/TEXTAREA so the agent can flip it without losing focus on
      // the composer.
      if (e.key === '.' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault()
        persistSmartComposeEnabled(!smartComposeEnabled)
        return
      }
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT') return
      if (e.key === 'E' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        handleEscalate()
      }
      if (e.key === 'R' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        handleResolve()
      }
    }
    document.addEventListener('keydown', handleGlobalKey)
    return () => document.removeEventListener('keydown', handleGlobalKey)
  }, [handleEscalate, handleResolve, persistSmartComposeEnabled, smartComposeEnabled])

  // Read-only roles see a banner instead of the action bar. Hides the
  // composer, templates, and approve/escalate/resolve controls so the UI
  // doesn't tease actions whose API calls would 403. All hooks above must
  // run unconditionally — the early-return must stay below them.
  if (isReadOnly) {
    return (
      <div className="sticky bottom-0 bg-white border-t border-border py-3 px-5 z-10">
        <div className="flex items-center gap-2 rounded-md border border-border bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
          <Eye size={14} className="text-zinc-500" />
          <span>Read-only access. Contact your admin to upgrade your role to reply, escalate, or resolve.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="sticky bottom-0 bg-white border-t border-border py-4 px-5 z-10 space-y-4">
      {/* Hidden file input shared by every paperclip button in the composer */}
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleAttachmentFiles}
      />

      {/* Failed sends — a queued reply the dispatcher couldn't deliver after
          the undo window closed. The customer never received it, so this
          stays loud (red) until the agent retries or dismisses it. */}
      {failedSends.map((item) => {
        const errText = item.error
          ? item.error.length > 120
            ? item.error.slice(0, 120).trimEnd() + '…'
            : item.error
          : 'delivery failed'
        const isBusy = failedActionId === item.id
        return (
          <div
            key={`${item.kind}-${item.id}`}
            className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2"
          >
            <AlertTriangle size={14} className="shrink-0 mt-0.5 text-red-600" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-red-800">
                Reply failed to send — {errText}
              </p>
              {item.body_preview && (
                <p className="mt-0.5 text-[11px] text-red-600/80 line-clamp-1">
                  &ldquo;{item.body_preview}&rdquo;
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                className="bg-white text-red-700 border border-red-200 hover:bg-red-100"
                onClick={() => handleFailedAction(item, 'retry')}
                disabled={isBusy}
                title="Re-queue this reply — it sends within a minute"
              >
                {isBusy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                Retry
              </Button>
              <button
                type="button"
                onClick={() => handleFailedAction(item, 'dismiss')}
                disabled={isBusy}
                aria-label="Dismiss failed send"
                title="Dismiss"
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-red-400 hover:bg-red-100 hover:text-red-700 disabled:opacity-50"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )
      })}

      {/* Schedule-send modal — routed through the shared <Modal> so it inherits
          the focus trap, Escape, scroll-lock, and role="dialog"/aria-modal
          wiring. The bespoke header/body/footer render full-bleed via
          bodyClassName="p-0"; Modal owns the backdrop + centering. */}
      <Modal
        open={showScheduleModal}
        onClose={() => setShowScheduleModal(false)}
        ariaLabel="Schedule reply"
        className="overflow-hidden"
        bodyClassName="p-0"
      >
            {/* Header */}
            <div className="flex items-start justify-between gap-4 border-b border-border bg-gradient-to-b from-indigo-50/40 to-transparent px-6 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200">
                  <Clock className="h-4 w-4" strokeWidth={2} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-[15px] font-semibold leading-tight text-zinc-900">Schedule reply</h3>
                  <p className="mt-0.5 text-xs text-zinc-500">Pick when this reply should be sent.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowScheduleModal(false)}
                aria-label="Close"
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
              >
                <X className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>

            <div className="space-y-4 px-6 py-5">
              {/* Quick-pick chips */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Quick picks</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {[
                    { key: 'in1h', label: 'In 1 hour' },
                    { key: 'tomorrow9', label: 'Tomorrow 9am' },
                    { key: 'monday9', label: 'Monday 9am' },
                    { key: 'nextweek', label: 'Next week' },
                  ].map((q) => (
                    <button
                      key={q.key}
                      type="button"
                      onClick={() => applyQuickPick(q.key as 'in1h' | 'tomorrow9' | 'monday9' | 'nextweek')}
                      className="inline-flex items-center rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-100"
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Datetime picker */}
              <div>
                <label htmlFor="schedule-datetime" className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  Send at
                </label>
                <input
                  id="schedule-datetime"
                  type="datetime-local"
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-zinc-300 px-3.5 py-2.5 text-sm tabular-nums text-zinc-800 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              {/* Preview */}
              {schedulePreview && (
                <div
                  className={`rounded-xl px-3.5 py-2.5 text-xs ring-1 ${
                    schedulePreview.invalid
                      ? 'bg-red-50 text-red-700 ring-red-200'
                      : 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                  }`}
                >
                  {schedulePreview.invalid
                    ? 'Scheduled time must be at least a minute from now.'
                    : <>Will send at <span className="font-semibold tabular-nums">{schedulePreview.abs}</span> ({schedulePreview.rel}).</>
                  }
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-border bg-zinc-50/50 px-6 py-3">
              <Button size="sm" variant="ghost" onClick={() => setShowScheduleModal(false)} disabled={scheduling}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={handleScheduleSubmit}
                disabled={scheduling || !scheduledFor || (schedulePreview?.invalid ?? false)}
              >
                {scheduling ? <Loader2 size={14} className="animate-spin" /> : <Clock size={14} />}
                Schedule
              </Button>
            </div>
      </Modal>


      {/* Info banner — only show for active/unreplied conversations.
         Was previously styled as `amber-50/700` (warning yellow) which
         signalled that something is broken. This is just informational —
         agents who reply via Gmail/Teams directly need to know they can
         click "Mark as Replied" to sync the status. Switched to info-blue
         per the UI audit. */}
      {isActiveConvo && (
        <div className="flex items-start gap-2 rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
          <Info size={14} className="shrink-0 mt-0.5 text-blue-600" />
          <span>
            Replied from {getChannel(channel)?.label ?? 'this channel'} directly? Click <strong>&quot;Mark as Replied&quot;</strong> to sync the status here.
          </span>
        </div>
      )}

      {/* Reply compose areas */}
      {showManualReply && (
        <div className="rounded-lg border border-border bg-zinc-50 p-4 space-y-3">
          {/* Teams reply destination indicator */}
          {channel === 'teams' && teamsChatId && (
            <div className="flex items-center gap-2 rounded-lg bg-indigo-50 border border-indigo-100 px-3 py-2 text-xs text-indigo-700">
              <svg className="h-4 w-4 shrink-0 text-indigo-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span>
                Replying to <strong>{participantName || participantEmail || 'customer'}</strong> via Teams
                {teamsChatId.includes('uni01_') ? ' (1:1 Direct Message)' : ' (Group Chat)'}
                <span className="text-indigo-400 ml-1">• {accountName.replace(/\s+Teams$/i, '')}</span>
              </span>
            </div>
          )}
          {/* Reply preview */}
          {showPreview && manualText.trim() && (
            <div className="rounded-lg border border-teal-200 bg-white p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs text-teal-600 font-medium">
                <Eye size={12} />
                Preview — How the customer will see this
              </div>
              <div className="text-sm text-zinc-800 leading-relaxed whitespace-pre-wrap border-l-3 border-teal-300 pl-3">
                {manualText}
              </div>
              <p className="text-[11px] text-zinc-500">From: {accountName}</p>
            </div>
          )}
          <div className="relative">
            {/* Smart Compose ghost-text overlay.
                Sits in the same position/font as the textarea so the suggestion
                appears to flow directly after the user's typed text. The
                textarea sits ON TOP (z-10) so it stays interactive. The ghost
                layer is non-interactive (pointer-events-none) and renders the
                user's own text invisibly so the suggestion offsets correctly.
                Only shown when there's a live suggestion. */}
            {smartSuggestion && smartComposeEnabled && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-0 overflow-hidden whitespace-pre-wrap break-words rounded-lg px-3.5 py-3 text-sm leading-relaxed"
                style={{ fontFamily: 'inherit' }}
              >
                <span className="invisible">{manualText}</span>
                <span className="italic text-zinc-400">{smartSuggestion}</span>
              </div>
            )}
            <textarea
              ref={manualTextareaRef}
              aria-label="Reply message"
              value={manualText}
              onChange={handleManualTextChange}
              onKeyDown={handleManualTextKeyDown}
              onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart)}
              onClick={(e) => setCursorPos(e.currentTarget.selectionStart)}
              onSelect={(e) => setCursorPos(e.currentTarget.selectionStart)}
              onBlur={dismissSmartSuggestion}
              placeholder="Type your reply... (use /shortcut for quick templates)"
              className="relative z-10 w-full rounded-lg border border-zinc-300 bg-transparent px-3.5 py-3 text-sm leading-relaxed focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 min-h-[140px] resize-y"
              rows={6}
            />
            {/* Shortcut autocomplete popup */}
            {shortcutQuery !== null && shortcutTemplates.length > 0 && (
              <div className="absolute bottom-full left-0 mb-1 w-full max-w-md rounded-lg border border-border bg-white shadow-lg z-30 max-h-56 overflow-y-auto">
                <div className="px-3 py-1.5 border-b border-border">
                  <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Template Shortcuts</p>
                </div>
                {shortcutTemplates.map((template, idx) => (
                  <button
                    key={template.id}
                    onClick={() => handleShortcutSelect(template)}
                    onMouseEnter={() => setShortcutIndex(idx)}
                    className={`w-full px-3 py-2 text-left transition-colors flex items-start gap-2 ${
                      idx === shortcutIndex ? 'bg-teal-50' : 'hover:bg-zinc-50'
                    }`}
                  >
                    <span className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-mono text-zinc-600 shrink-0 mt-0.5">
                      /{template.shortcut}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-800 truncate">{template.title}</span>
                        {template.category && (
                          <Badge variant="default" size="sm">{template.category}</Badge>
                        )}
                      </div>
                      <p className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{template.content}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {shortcutQuery !== null && shortcutTemplates.length === 0 && shortcutLoaded && shortcutQuery.length > 0 && (
              <div className="absolute bottom-full left-0 mb-1 w-64 rounded-lg border border-border bg-white shadow-lg z-30 p-3">
                <p className="text-xs text-zinc-500 text-center">No matching shortcuts</p>
              </div>
            )}
          </div>
          {/* Pending attachment chips */}
          <AttachmentChips />

          {/* Inline signature preview — email channel only. Faded so the
              agent knows it's auto-appended at send time, not part of the
              text they're editing. Hidden when the user has the toggle
              off OR the resolver returned null (no signature configured). */}
          {isEmailChannel && appendSignature && resolvedSignature && (
            <div className="rounded-md border border-dashed border-border bg-white px-3 py-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                  Signature (will be appended)
                </span>
                <button
                  type="button"
                  onClick={() => persistAppendSignature(false)}
                  className="text-[11px] text-zinc-500 hover:text-zinc-700 underline"
                >
                  hide
                </button>
              </div>
              <pre className="whitespace-pre-wrap font-sans text-xs text-zinc-500 italic">
                {resolvedSignature}
              </pre>
            </div>
          )}

          <div className="flex gap-2 justify-end items-center">
            {isEmailChannel ? (
              <button
                type="button"
                onClick={handleAttachmentPick}
                disabled={uploadingAttachments}
                title="Attach files"
                aria-label="Attach files"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-700 ring-1 ring-zinc-200 bg-white hover:bg-zinc-100 disabled:opacity-60"
              >
                {uploadingAttachments ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
              </button>
            ) : (
              <button
                type="button"
                disabled
                title="Attachments are only supported for Email right now"
                aria-label="Attachments disabled on this channel"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-300 ring-1 ring-zinc-200 bg-white cursor-not-allowed"
              >
                <Paperclip size={14} />
              </button>
            )}
            {/* Email-only "Include signature" toggle. Tiny chip-style button
                so it doesn't compete with the primary Send action. Hidden
                when no signature is configured for this user/company —
                showing an off-only toggle would be confusing. */}
            {isEmailChannel && (resolvedSignature !== null || !signatureLoaded) && (
              <button
                type="button"
                onClick={() => persistAppendSignature(!appendSignature)}
                title={
                  resolvedSignature === null
                    ? 'No signature configured — set one in Account → Signature'
                    : appendSignature
                      ? 'Signature will be appended on send'
                      : 'Signature is OFF — click to include it'
                }
                disabled={resolvedSignature === null}
                className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium ring-1 transition-colors disabled:opacity-50 ${
                  appendSignature && resolvedSignature !== null
                    ? 'bg-zinc-200 text-zinc-700 ring-zinc-300 hover:bg-zinc-300'
                    : 'bg-zinc-50 text-zinc-500 ring-zinc-200 hover:bg-zinc-100'
                }`}
                aria-pressed={appendSignature}
              >
                <FileText size={11} />
                {appendSignature ? 'Signature on' : 'Signature off'}
              </button>
            )}
            <Button size="sm" variant="ghost" onClick={() => { setShowManualReply(false); setShortcutQuery(null) }}>
              <X size={14} /> Cancel
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setShowPreview(!showPreview)}>
              <Eye size={14} /> {showPreview ? 'Hide Preview' : 'Preview'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={openScheduleModal}
              disabled={scheduling}
              title="Schedule this reply to send later"
            >
              <Clock size={14} />
              Schedule
            </Button>
            {/* Send button — `whitespace-nowrap` so the label never wraps
                onto a second line. Tooltip carries the keyboard hint
                instead of a persistent inline label, removing the cluttered
                "AI On / Ctrl+Enter / to send" column the audit flagged. */}
            <Button
              size="sm"
              variant="primary"
              onClick={guardedManualReply}
              disabled={loading === 'manual' || !canSend}
              className="whitespace-nowrap"
              title={!canSend ? 'You do not have permission to send replies' : 'Send (Ctrl+Enter)'}
            >
              {loading === 'manual' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send Reply
            </Button>
            {/* Compact status row — only the AI toggle stays persistent;
                draft-saved + tab-to-accept are inline only when relevant.
                Removed the always-on "Ctrl+Enter to send" hint that was
                turning the strip into a wall of micro-text. */}
            <span className="text-[11px] text-zinc-500 flex items-center gap-2 ml-auto">
              {draftSaved && <span className="text-green-700">Draft saved</span>}
              {smartSuggestion && smartComposeEnabled && (
                <span className="text-zinc-600">
                  <kbd className="px-1 py-0.5 bg-zinc-100 rounded text-[10px] font-mono ring-1 ring-zinc-200">Tab</kbd> to accept
                </span>
              )}
              <button
                type="button"
                onClick={() => persistSmartComposeEnabled(!smartComposeEnabled)}
                title={`Smart Compose is ${smartComposeEnabled ? 'on' : 'off'} — Ctrl+. to toggle`}
                className={`px-1.5 py-0.5 rounded text-[11px] font-medium ring-1 transition-colors ${
                  smartComposeEnabled
                    ? 'bg-zinc-200 text-zinc-700 ring-zinc-300 hover:bg-zinc-300'
                    : 'bg-zinc-100 text-zinc-500 ring-zinc-200 hover:bg-zinc-200'
                }`}
              >
                AI {smartComposeEnabled ? 'On' : 'Off'}
              </button>
            </span>
          </div>
        </div>
      )}

      {showEditReply && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 space-y-2">
          <p className="text-xs font-medium text-teal-700">Edit AI Draft</p>
          <textarea
            value={editText}
            aria-label="Edited AI draft reply"
            onChange={(e) => setEditText(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 min-h-[120px] resize-y"
            rows={5}
          />
          <AttachmentChips />
          <div className="flex gap-2 justify-end items-center">
            {isEmailChannel ? (
              <button
                type="button"
                onClick={handleAttachmentPick}
                disabled={uploadingAttachments}
                title="Attach files"
                aria-label="Attach files"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-700 ring-1 ring-zinc-200 bg-white hover:bg-zinc-100 disabled:opacity-60"
              >
                {uploadingAttachments ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
              </button>
            ) : (
              <button
                type="button"
                disabled
                title="Attachments are only supported for Email right now"
                aria-label="Attachments disabled on this channel"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-300 ring-1 ring-zinc-200 bg-white cursor-not-allowed"
              >
                <Paperclip size={14} />
              </button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setShowEditReply(false)}>
              <X size={14} /> Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={handleEditSend}
              disabled={loading === 'edit' || !canSend}
              title={!canSend ? 'You do not have permission to send replies' : undefined}
            >
              {loading === 'edit' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send Edited Reply
            </Button>
          </div>
        </div>
      )}

      {/* Action buttons.
          The two visual rows separate concerns the previous single
          flex-wrap row blurred:
            Row 1 — Compose / send actions (Approve, Edit, Manual,
            Templates, Mark as Replied) — what the agent does *with* the
            current draft.
            Row 2 — Conversation-state actions (Escalate, Resolve) —
            what the agent does *to the conversation as a whole*.
          A hairline border between the rows reads as "different scope"
          and stops the dual-purpose toolbar from looking like one
          undifferentiated wall of buttons. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* AI approve / edit-draft actions are supervisor+ only. Members can
            still see the AI draft in the sidebar (read-only) and reply
            manually, but can't approve/send it as-is or edit it. */}
        {aiReplyId && aiReplyStatus === 'pending_approval' && canApproveAI && (
          <Button
            size="sm"
            variant="primary"
            onClick={handleApprove}
            disabled={loading === 'approve' || !canSend}
            title={!canSend ? 'You do not have permission to send replies' : undefined}
          >
            {loading === 'approve' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
            Approve &amp; Send
          </Button>
        )}
        {aiDraftText && canApproveAI && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => { setShowEditReply(!showEditReply); setShowManualReply(false) }}
          >
            <Pencil size={14} />
            Edit &amp; Send
          </Button>
        )}
        {/* View-only marker shown to members when an AI draft exists so they
            understand why the Approve / Edit buttons aren't there. Tiny and
            unobtrusive — appears next to Manual Reply. */}
        {aiDraftText && !canApproveAI && (
          <span
            className="inline-flex items-center gap-1 rounded-md bg-zinc-50 px-2 py-1 text-[11px] font-medium text-zinc-500 ring-1 ring-zinc-200"
            title="AI draft is view-only for your role — reply manually or ask a supervisor to approve."
          >
            <Eye size={11} /> AI draft (view only)
          </span>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => { setShowManualReply(!showManualReply); setShowEditReply(false); setShowTemplates(false) }}
        >
          <MessageSquare size={14} />
          Manual Reply
        </Button>
        {/* Templates dropdown */}
        <div className="relative">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setShowTemplates(!showTemplates)}
          >
            <FileText size={14} />
            Templates
            <ChevronDown size={12} />
          </Button>
          {showTemplates && (
            <div className="absolute bottom-full left-0 mb-1 w-[28rem] rounded-lg border border-border bg-white shadow-lg z-20">
              <div className="px-4 py-3 border-b border-border space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-zinc-800">Canned Responses</p>
                  <span className="text-xs text-zinc-500">{templates.length} templates</span>
                </div>
                {/* Search input */}
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    type="text"
                    value={templateSearch}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                    placeholder="Search templates..."
                    className="w-full rounded-md border border-zinc-200 py-1.5 pl-8 pr-3 text-xs focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                  />
                </div>
                {/* Category filter */}
                {categories.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    <button
                      onClick={() => setSelectedCategory('all')}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
                        selectedCategory === 'all'
                          ? 'bg-teal-100 text-teal-700'
                          : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                      }`}
                    >
                      All
                    </button>
                    {categories.map((cat) => (
                      <button
                        key={cat}
                        onClick={() => setSelectedCategory(cat)}
                        className={`rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
                          selectedCategory === cat
                            ? 'bg-teal-100 text-teal-700'
                            : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                        }`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="py-1 max-h-64 overflow-y-auto">
                {templatesLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 size={18} className="animate-spin text-zinc-400" />
                  </div>
                ) : filteredTemplates.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-zinc-500">
                    No templates found
                  </div>
                ) : (
                  filteredTemplates.map((template) => (
                    <button
                      key={template.id}
                      onClick={() => handleTemplateSelect(template)}
                      className="w-full px-3 py-2 text-left hover:bg-zinc-50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-zinc-800">{template.title}</p>
                        {template.category && (
                          <Badge variant="default" size="sm">{template.category}</Badge>
                        )}
                      </div>
                      <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{template.content}</p>
                      {template.usage_count > 0 && (
                        <p className="text-xs text-zinc-400 mt-0.5">Used {template.usage_count} times</p>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Conversation-state actions — visually separated from the
          compose/send row above so it's clear these mutate the
          conversation as a whole, not just the current draft. The
          tiny "Conversation actions" caption gives the section a
          name (was a single un-labeled flex row before, which the
          UI audit called out as ambiguous-scope). */}
      <div className="border-t border-border pt-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Conversation actions
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={handleMarkReplied}
            disabled={loading === 'mark_replied' || !canSend}
            title={!canSend ? 'You do not have permission to update conversations' : undefined}
          >
            {loading === 'mark_replied' ? <Loader2 size={14} className="animate-spin" /> : <CheckCheck size={14} />}
            Mark as Replied
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={handleEscalate}
            disabled={loading === 'escalate' || !canSend}
            title={!canSend ? 'You do not have permission to update conversations' : undefined}
          >
            {loading === 'escalate' ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
            Escalate
          </Button>
          <Button
            size="sm"
            variant="success"
            onClick={handleResolve}
            disabled={loading === 'resolve' || !canSend}
            title={!canSend ? 'You do not have permission to update conversations' : undefined}
          >
            {loading === 'resolve' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
            Resolve
          </Button>
          <MacroRunner conversationId={conversationId} onApplied={() => router.refresh()} />
        </div>
      </div>
    </div>
  )
}
