'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase-client'
import { useToast } from '@/components/ui/toast'
import { useConversationPresence } from '@/hooks/useConversationPresence'
import { useSmartCompose } from '@/hooks/useSmartCompose'
import type { ReplyTemplate } from '@/types/database'
import { substituteTemplate as substituteTemplateVars } from '@/lib/templates'

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
  participantName,
  emailSubject,
  teamsChatId,
  conversationStatus = 'active',
  currentUserId,
  currentUserName,
}: ConversationActionsProps) {
  const router = useRouter()
  const { toast } = useToast()
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

  // Helper: update conversation status + mark inbound messages as replied
  const markWaitingOnCustomer = useCallback(async () => {
    try {
      const supabase = createClient()
      await supabase
        .from('conversations')
        .update({ status: 'waiting_on_customer' })
        .eq('id', conversationId)
      // Mark all unreplied inbound messages as replied
      await supabase
        .from('messages')
        .update({ replied: true })
        .eq('conversation_id', conversationId)
        .eq('direction', 'inbound')
        .eq('replied', false)
    } catch { /* non-critical */ }
  }, [conversationId])
  const isActiveConvo = conversationStatus === 'active' || conversationStatus === 'in_progress' || conversationStatus === 'escalated' || conversationStatus === 'waiting_on_customer'
  const [showManualReply, setShowManualReply] = useState(isActiveConvo)
  const [showPreview, setShowPreview] = useState(false)
  const [showEditReply, setShowEditReply] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const draftTimerRef = useRef<NodeJS.Timeout | null>(null)
  const sendReplyRef = useRef<(() => void) | null>(null)

  // Start empty so SSR output matches the first client render. The saved
  // draft is hydrated in the effect below to avoid a hydration mismatch.
  const [manualText, setManualText] = useState('')
  const [editText, setEditText] = useState(aiDraftText || '')

  // Schedule-send modal state
  const [showScheduleModal, setShowScheduleModal] = useState(false)
  const [scheduledFor, setScheduledFor] = useState<string>('') // datetime-local string
  const [scheduling, setScheduling] = useState(false)

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
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-50 text-gray-700 px-2.5 py-1 text-xs ring-1 ring-gray-200"
          >
            <Paperclip size={11} className="text-gray-400" />
            <span className="max-w-[14rem] truncate">{a.filename}</span>
            <span className="tabular-nums text-gray-400">{formatBytes(a.size)}</span>
            <button
              type="button"
              onClick={() => handleRemoveAttachment(a.path)}
              className="ml-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-700"
              aria-label={`Remove ${a.filename}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {uploadingAttachments && (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-teal-50 text-teal-700 px-2.5 py-1 text-xs ring-1 ring-teal-200">
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
      // user.full_name / user.email are filled by the server only when a
      // template comes from the API; client-side composer doesn't have a
      // profile reference handy, so we fall back to the participant.
      user: null,
      company: { name: accountClean },
      conversation: { subject: emailSubject || null },
    })
    return withModernVars
      .replace(/\{\{customer_name\}\}/gi, participantName || participantEmail || 'Customer')
      .replace(/\{\{account_name\}\}/gi, accountClean)
      .replace(/\{\{email_subject\}\}/gi, emailSubject || '')
      .replace(/\{\{channel\}\}/gi, channel)
  }, [participantName, participantEmail, accountName, emailSubject, channel])

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
    enabled: smartComposeEnabled && showManualReply,
    isSendInFlight: isSending,
    textareaRef: manualTextareaRef,
  })

  // Fetch templates via the company-scoped API. RLS handles isolation.
  const fetchTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    try {
      const res = await fetch('/api/templates')
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
      const res = await fetch('/api/templates')
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
    [toast]
  )

  const handleApprove = useCallback(async () => {
    if (!aiReplyId) return
    if (!participantEmail && channel !== 'teams') {
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
        to: participantEmail,
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
  }, [aiReplyId, accountId, aiDraftText, conversationId, participantEmail, router, toast, channel, emailSubject, teamsChatId, markWaitingOnCustomer, serverUndoableSend, isEmailChannel, attachmentsForSend])

  const handleEditSend = useCallback(async () => {
    if (!participantEmail && channel !== 'teams') {
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
        to: participantEmail,
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
  }, [editText, aiReplyId, accountId, participantEmail, conversationId, router, toast, channel, emailSubject, teamsChatId, markWaitingOnCustomer, serverUndoableSend, isEmailChannel, attachmentsForSend])

  const handleManualReply = useCallback(async () => {
    if (!participantEmail && channel !== 'teams') {
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
        to: participantEmail,
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
  }, [manualText, conversationId, accountId, channel, participantEmail, router, toast, emailSubject, teamsChatId, markWaitingOnCustomer, clearDraft, serverUndoableSend, isEmailChannel, attachmentsForSend, pendingAttachments.length, appendSignature])

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
    if (!participantEmail && channel !== 'teams') {
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
  }, [participantEmail, channel, manualText, toast, toLocalDatetimeValue])

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
          to: participantEmail,
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

  const handleMarkReplied = useCallback(async () => {
    setLoading('mark_replied')
    try {
      const supabase = createClient()
      // Mark all unreplied inbound messages in this conversation as replied
      const { error } = await supabase
        .from('messages')
        .update({ replied: true, reply_required: false })
        .eq('conversation_id', conversationId)
        .eq('direction', 'inbound')
        .eq('replied', false)
      if (error) throw error

      // Update conversation status to resolved
      await supabase
        .from('conversations')
        .update({ status: 'resolved' })
        .eq('id', conversationId)

      toast.success('Marked as replied (replied outside portal)')
      router.refresh()
    } catch (err: any) {
      toast.error('Failed: ' + err.message)
    } finally {
      setLoading(null)
    }
  }, [conversationId, router, toast])

  const handleEscalate = useCallback(async () => {
    setLoading('escalate')
    try {
      const supabase = createClient()

      // 1. Update conversation status + priority
      const { error } = await supabase
        .from('conversations')
        .update({ status: 'escalated', priority: 'urgent' })
        .eq('id', conversationId)
      if (error) throw error

      // 2. Auto-assign to first admin user
      const { data: adminUser } = await supabase
        .from('users')
        .select('id, email, full_name')
        .eq('role', 'admin')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()

      if (adminUser) {
        await supabase
          .from('conversations')
          .update({ assigned_to: adminUser.id })
          .eq('id', conversationId)
      }

      // 3. Log to audit trail
      const { data: { user: currentUser } } = await supabase.auth.getUser()
      try {
        await supabase.from('audit_log').insert({
          user_id: currentUser?.id || null,
          action: 'conversation_escalated',
          entity_type: 'conversation',
          entity_id: conversationId,
          details: {
            account_name: accountName,
            channel,
            participant_email: participantEmail,
            assigned_to_admin: adminUser?.email || null,
          },
        })
      } catch { /* fire-and-forget */ }

      // 4. Send email notification to admin
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
            message_preview: `This conversation has been escalated to urgent priority and assigned to you.`,
            conversation_id: conversationId,
            priority: 'urgent',
          }),
        }).catch(() => {}) // fire-and-forget
      }

      toast.success(`Conversation escalated!${adminUser ? ` Assigned to ${adminUser.full_name || adminUser.email}` : ''}`)
      router.refresh()
    } catch (err: any) {
      toast.error('Failed to escalate: ' + err.message)
    } finally {
      setLoading(null)
    }
  }, [conversationId, accountName, channel, participantEmail, emailSubject, router, toast])

  const handleResolve = useCallback(async () => {
    setLoading('resolve')
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from('conversations')
        .update({ status: 'resolved' })
        .eq('id', conversationId)
      if (error) throw error
      toast.success('Conversation resolved!')
      router.refresh()
    } catch (err: any) {
      toast.error('Failed to resolve: ' + err.message)
    } finally {
      setLoading(null)
    }
  }, [conversationId, router, toast])

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

  return (
    <div className="sticky bottom-0 bg-white border-t border-gray-200 py-3 px-4 z-10 space-y-3">
      {/* Hidden file input shared by every paperclip button in the composer */}
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleAttachmentFiles}
      />

      {/* Schedule-send modal */}
      {showScheduleModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowScheduleModal(false) }}
        >
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-[0_20px_60px_rgba(16,24,40,0.18),0_4px_12px_rgba(16,24,40,0.08)]">
            {/* Header */}
            <div className="flex items-start justify-between gap-4 border-b border-gray-100 bg-gradient-to-b from-indigo-50/40 to-transparent px-6 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200">
                  <Clock className="h-4 w-4" strokeWidth={2} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-[15px] font-semibold leading-tight text-gray-900">Schedule reply</h3>
                  <p className="mt-0.5 text-xs text-gray-500">Pick when this reply should be sent.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowScheduleModal(false)}
                aria-label="Close"
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              >
                <X className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>

            <div className="space-y-4 px-6 py-5">
              {/* Quick-pick chips */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Quick picks</p>
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
                <label htmlFor="schedule-datetime" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  Send at
                </label>
                <input
                  id="schedule-datetime"
                  type="datetime-local"
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm tabular-nums text-gray-800 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
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
            <div className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50/50 px-6 py-3">
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
          </div>
        </div>
      )}

      {/* Warning banner — only show for active/unreplied conversations */}
      {isActiveConvo && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
          <Info size={14} className="shrink-0 mt-0.5" />
          <span>
            Replied from {channel === 'teams' ? 'Teams' : channel === 'whatsapp' ? 'WhatsApp' : 'Gmail'} directly? Click <strong>&quot;Mark as Replied&quot;</strong> to sync the status here.
          </span>
        </div>
      )}

      {/* Reply compose areas */}
      {showManualReply && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
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
              <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap border-l-3 border-teal-300 pl-3">
                {manualText}
              </div>
              <p className="text-[10px] text-gray-400">From: {accountName}</p>
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
                <span className="italic text-gray-400">{smartSuggestion}</span>
              </div>
            )}
            <textarea
              ref={manualTextareaRef}
              value={manualText}
              onChange={handleManualTextChange}
              onKeyDown={handleManualTextKeyDown}
              onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart)}
              onClick={(e) => setCursorPos(e.currentTarget.selectionStart)}
              onSelect={(e) => setCursorPos(e.currentTarget.selectionStart)}
              onBlur={dismissSmartSuggestion}
              placeholder="Type your reply... (use /shortcut for quick templates)"
              className="relative z-10 w-full rounded-lg border border-gray-300 bg-transparent px-3.5 py-3 text-sm leading-relaxed focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 min-h-[140px] resize-y"
              rows={6}
            />
            {/* Shortcut autocomplete popup */}
            {shortcutQuery !== null && shortcutTemplates.length > 0 && (
              <div className="absolute bottom-full left-0 mb-1 w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-lg z-30 max-h-56 overflow-y-auto">
                <div className="px-3 py-1.5 border-b border-gray-100">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Template Shortcuts</p>
                </div>
                {shortcutTemplates.map((template, idx) => (
                  <button
                    key={template.id}
                    onClick={() => handleShortcutSelect(template)}
                    onMouseEnter={() => setShortcutIndex(idx)}
                    className={`w-full px-3 py-2 text-left transition-colors flex items-start gap-2 ${
                      idx === shortcutIndex ? 'bg-teal-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-gray-600 shrink-0 mt-0.5">
                      /{template.shortcut}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-800 truncate">{template.title}</span>
                        {template.category && (
                          <Badge variant="default" size="sm">{template.category}</Badge>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{template.content}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {shortcutQuery !== null && shortcutTemplates.length === 0 && shortcutLoaded && shortcutQuery.length > 0 && (
              <div className="absolute bottom-full left-0 mb-1 w-64 rounded-lg border border-gray-200 bg-white shadow-lg z-30 p-3">
                <p className="text-xs text-gray-400 text-center">No matching shortcuts</p>
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
            <div className="rounded-md border border-dashed border-gray-200 bg-white px-3 py-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase tracking-wider text-gray-400">
                  Signature (will be appended)
                </span>
                <button
                  type="button"
                  onClick={() => persistAppendSignature(false)}
                  className="text-[10px] text-gray-400 hover:text-gray-600 underline"
                >
                  hide
                </button>
              </div>
              <pre className="whitespace-pre-wrap font-sans text-xs text-gray-400 italic">
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
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 ring-1 ring-gray-200 bg-white hover:bg-gray-50 hover:text-gray-700 disabled:opacity-60"
              >
                {uploadingAttachments ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
              </button>
            ) : (
              <button
                type="button"
                disabled
                title="Attachments are only supported for Email right now"
                aria-label="Attachments disabled on this channel"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-300 ring-1 ring-gray-200 bg-white cursor-not-allowed"
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
                    ? 'bg-teal-50 text-teal-700 ring-teal-200 hover:bg-teal-100'
                    : 'bg-gray-50 text-gray-500 ring-gray-200 hover:bg-gray-100'
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
              className="bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200"
              onClick={openScheduleModal}
              disabled={scheduling}
              title="Schedule this reply to send later"
            >
              <Clock size={14} />
              Schedule
            </Button>
            <Button size="sm" variant="primary" onClick={guardedManualReply} disabled={loading === 'manual'}>
              {loading === 'manual' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send Reply
            </Button>
            <span className="text-[10px] text-gray-400 flex items-center gap-2 ml-auto">
              {draftSaved && <span className="text-green-500">Draft saved</span>}
              {smartSuggestion && smartComposeEnabled && (
                <span className="text-teal-600">
                  <kbd className="px-1 py-0.5 bg-teal-50 rounded text-[9px] font-mono ring-1 ring-teal-200">Tab</kbd> to accept
                </span>
              )}
              <button
                type="button"
                onClick={() => persistSmartComposeEnabled(!smartComposeEnabled)}
                title={`Smart Compose is ${smartComposeEnabled ? 'on' : 'off'} — Ctrl+. to toggle`}
                className={`px-1.5 py-0.5 rounded text-[9px] font-mono ring-1 transition-colors ${
                  smartComposeEnabled
                    ? 'bg-teal-50 text-teal-700 ring-teal-200 hover:bg-teal-100'
                    : 'bg-gray-100 text-gray-500 ring-gray-200 hover:bg-gray-200'
                }`}
              >
                AI {smartComposeEnabled ? 'On' : 'Off'}
              </button>
              <kbd className="px-1 py-0.5 bg-gray-100 rounded text-[9px] font-mono">Ctrl+Enter</kbd> to send
            </span>
          </div>
        </div>
      )}

      {showEditReply && (
        <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 space-y-2">
          <p className="text-xs font-medium text-purple-700">Edit AI Draft</p>
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            className="w-full rounded-lg border border-purple-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500 min-h-[120px] resize-y"
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
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-purple-500 ring-1 ring-purple-200 bg-white hover:bg-purple-50 hover:text-purple-700 disabled:opacity-60"
              >
                {uploadingAttachments ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
              </button>
            ) : (
              <button
                type="button"
                disabled
                title="Attachments are only supported for Email right now"
                aria-label="Attachments disabled on this channel"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-300 ring-1 ring-gray-200 bg-white cursor-not-allowed"
              >
                <Paperclip size={14} />
              </button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setShowEditReply(false)}>
              <X size={14} /> Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={handleEditSend} disabled={loading === 'edit'}>
              {loading === 'edit' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send Edited Reply
            </Button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        {aiReplyId && aiReplyStatus === 'pending_approval' && (
          <Button size="sm" variant="success" onClick={handleApprove} disabled={loading === 'approve'}>
            {loading === 'approve' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
            Approve &amp; Send
          </Button>
        )}
        {aiDraftText && (
          <Button
            size="sm"
            variant="secondary"
            className="bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200"
            onClick={() => { setShowEditReply(!showEditReply); setShowManualReply(false) }}
          >
            <Pencil size={14} />
            Edit &amp; Send
          </Button>
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
            className="bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200"
            onClick={() => setShowTemplates(!showTemplates)}
          >
            <FileText size={14} />
            Templates
            <ChevronDown size={12} />
          </Button>
          {showTemplates && (
            <div className="absolute bottom-full left-0 mb-1 w-[28rem] rounded-xl border border-gray-200 bg-white shadow-xl z-20">
              <div className="px-4 py-3 border-b border-gray-100 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-800">Canned Responses</p>
                  <span className="text-xs text-gray-400">{templates.length} templates</span>
                </div>
                {/* Search input */}
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    value={templateSearch}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                    placeholder="Search templates..."
                    className="w-full rounded-md border border-gray-200 py-1.5 pl-8 pr-3 text-xs focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
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
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
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
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
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
                    <Loader2 size={18} className="animate-spin text-gray-400" />
                  </div>
                ) : filteredTemplates.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-gray-400">
                    No templates found
                  </div>
                ) : (
                  filteredTemplates.map((template) => (
                    <button
                      key={template.id}
                      onClick={() => handleTemplateSelect(template)}
                      className="w-full px-3 py-2 text-left hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-800">{template.title}</p>
                        {template.category && (
                          <Badge variant="default" size="sm">{template.category}</Badge>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{template.content}</p>
                      {template.usage_count > 0 && (
                        <p className="text-xs text-gray-300 mt-0.5">Used {template.usage_count} times</p>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="bg-green-50 text-green-700 hover:bg-green-100 border border-green-200"
          onClick={handleMarkReplied}
          disabled={loading === 'mark_replied'}
        >
          {loading === 'mark_replied' ? <Loader2 size={14} className="animate-spin" /> : <CheckCheck size={14} />}
          Mark as Replied
        </Button>
        <div className="mx-2 h-6 w-px bg-gray-200" />
        <Button
          size="sm"
          variant="danger"
          className="bg-orange-500 hover:bg-orange-600"
          onClick={handleEscalate}
          disabled={loading === 'escalate'}
        >
          {loading === 'escalate' ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
          Escalate
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-green-700 border border-green-300 hover:bg-green-50"
          onClick={handleResolve}
          disabled={loading === 'resolve'}
        >
          {loading === 'resolve' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
          Resolve
        </Button>
      </div>
    </div>
  )
}
