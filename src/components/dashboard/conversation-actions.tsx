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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase-client'
import { useToast } from '@/components/ui/toast'
import type { ReplyTemplate } from '@/types/database'

interface ConversationActionsProps {
  conversationId: string
  accountId: string
  accountName: string
  channel: string
  aiReplyId: string | null
  aiReplyStatus: string | null
  aiDraftText: string | null
  participantEmail: string | null
  emailSubject: string | null
  teamsChatId?: string | null
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
  emailSubject,
  teamsChatId,
}: ConversationActionsProps) {
  const router = useRouter()
  const { toast } = useToast()
  const supabaseRef = createClient()
  const [loading, setLoading] = useState<string | null>(null)

  // Helper: update conversation status to waiting_on_customer after reply sent
  const markWaitingOnCustomer = useCallback(async () => {
    try {
      await supabaseRef
        .from('conversations')
        .update({ status: 'waiting_on_customer' })
        .eq('id', conversationId)
    } catch { /* non-critical */ }
  }, [conversationId, supabaseRef])
  const [showManualReply, setShowManualReply] = useState(false)
  const [showEditReply, setShowEditReply] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [manualText, setManualText] = useState('')
  const [editText, setEditText] = useState(aiDraftText || '')

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

  // Fetch templates from Supabase
  const fetchTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('reply_templates')
        .select('*')
        .eq('is_active', true)
        .or(`account_id.is.null,account_id.eq.${accountId}`)
        .order('usage_count', { ascending: false })

      if (error) throw error
      setTemplates(data || [])
    } catch (err: any) {
      console.error('Failed to fetch templates:', err)
      // Fallback to empty - templates table might not exist yet
      setTemplates([])
    } finally {
      setTemplatesLoading(false)
    }
  }, [accountId])

  // Fetch templates when dropdown opens
  useEffect(() => {
    if (showTemplates) {
      fetchTemplates()
    }
  }, [showTemplates, fetchTemplates])

  // Fetch shortcut templates (templates that have a shortcut defined)
  const fetchShortcutTemplates = useCallback(async () => {
    if (shortcutLoaded) return
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('reply_templates')
        .select('*')
        .eq('is_active', true)
        .not('shortcut', 'is', null)
        .or(`account_id.is.null,account_id.eq.${accountId}`)
        .order('usage_count', { ascending: false })

      if (error) throw error
      setAllShortcutTemplates(data || [])
      setShortcutLoaded(true)
    } catch (err) {
      console.error('Failed to fetch shortcut templates:', err)
      setAllShortcutTemplates([])
      setShortcutLoaded(true)
    }
  }, [accountId, shortcutLoaded])

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

    // Detect "/" shortcut pattern
    const cursorPos = e.target.selectionStart
    const textBeforeCursor = value.substring(0, cursorPos)

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
  }, [shortcutLoaded, fetchShortcutTemplates])

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
      const newText = before + template.content + textAfterCursor
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

  // Handle keyboard navigation in shortcut popup
  const handleManualTextKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
  }, [shortcutQuery, shortcutTemplates, shortcutIndex, handleShortcutSelect])

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
    setManualText(template.content)
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
  }, [])

  const handleApprove = useCallback(async () => {
    if (!aiReplyId) return
    if (!participantEmail) {
      toast.error('No recipient email address found')
      return
    }
    if (!aiDraftText) {
      toast.error('No AI draft available to send')
      return
    }
    setLoading('approve')
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from('ai_replies')
        .update({ status: 'approved', reviewed_at: new Date().toISOString() })
        .eq('id', aiReplyId)
      if (error) throw error

      // Send the reply via n8n (channel-specific action)
      const actionMap: Record<string, string> = {
        email: 'send_email_reply',
        teams: 'send_teams_reply',
        whatsapp: 'send_whatsapp_reply',
      }
      const res = await fetch('/api/n8n', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: actionMap[channel] || 'send_email_reply',
          account_id: accountId,
          data: {
            to: participantEmail,
            subject: emailSubject ? `Re: ${emailSubject}` : 'Re: Your inquiry',
            body: aiDraftText,
            conversation_id: conversationId,
            reply_text: aiDraftText,
            teams_chat_id: teamsChatId || undefined,
          },
        }),
      })

      if (res.ok) {
        const now = new Date().toISOString()
        await supabase
          .from('ai_replies')
          .update({ status: 'sent', sent_at: now })
          .eq('id', aiReplyId)

        // Create outbound message record so it shows in the conversation thread
        await supabase.from('messages').insert({
          conversation_id: conversationId,
          account_id: accountId,
          channel: channel,
          sender_name: accountName,
          sender_type: 'ai',
          message_text: aiDraftText,
          direction: 'outbound',
          email_subject: emailSubject ? `Re: ${emailSubject}` : null,
          replied: true,
          reply_required: false,
          timestamp: now,
          received_at: now,
        })

        toast.success('AI reply approved and sent!')
        await markWaitingOnCustomer()
      } else {
        toast.warning('Reply approved but sending failed. You can retry from the inbox.')
      }
      router.refresh()
    } catch (err: any) {
      toast.error('Failed to approve: ' + err.message)
    } finally {
      setLoading(null)
    }
  }, [aiReplyId, accountId, accountName, aiDraftText, conversationId, participantEmail, router, toast, channel, emailSubject, teamsChatId])

  const handleEditSend = useCallback(async () => {
    if (!participantEmail) {
      toast.error('No recipient email address found')
      return
    }
    if (!editText.trim()) {
      toast.warning('Reply text cannot be empty.')
      return
    }
    setLoading('edit')
    try {
      const supabase = createClient()

      if (aiReplyId) {
        const { error: updateError } = await supabase
          .from('ai_replies')
          .update({
            edited_text: editText,
            final_text: editText,
            status: 'sent',
            sent_at: new Date().toISOString(),
          })
          .eq('id', aiReplyId)
        if (updateError) console.warn('Failed to update AI reply before sending:', updateError.message)
      }

      const editActionMap: Record<string, string> = {
        email: 'send_email_reply',
        teams: 'send_teams_reply',
        whatsapp: 'send_whatsapp_reply',
      }
      const res = await fetch('/api/n8n', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: editActionMap[channel] || 'send_email_reply',
          account_id: accountId,
          data: {
            to: participantEmail,
            subject: emailSubject ? `Re: ${emailSubject}` : 'Re: Your inquiry',
            body: editText,
            conversation_id: conversationId,
            reply_text: editText,
            teams_chat_id: teamsChatId || undefined,
          },
        }),
      })

      if (res.ok) {
        // Create outbound message record so it shows in the conversation thread
        const now = new Date().toISOString()
        await supabase.from('messages').insert({
          conversation_id: conversationId,
          account_id: accountId,
          channel: channel,
          sender_name: accountName,
          sender_type: 'agent',
          message_text: editText,
          direction: 'outbound',
          email_subject: emailSubject ? `Re: ${emailSubject}` : null,
          replied: true,
          reply_required: false,
          timestamp: now,
          received_at: now,
        })

        toast.success('Reply sent successfully!')
        await markWaitingOnCustomer()
      } else {
        toast.error('Failed to send reply.')
      }
      setShowEditReply(false)
      router.refresh()
    } catch (err: any) {
      toast.error('Failed: ' + err.message)
    } finally {
      setLoading(null)
    }
  }, [editText, aiReplyId, accountId, accountName, participantEmail, conversationId, router, toast, channel, emailSubject, teamsChatId])

  const handleManualReply = useCallback(async () => {
    if (!participantEmail) {
      toast.error('No recipient email address found')
      return
    }
    if (!manualText.trim()) {
      toast.warning('Reply text cannot be empty.')
      return
    }
    setLoading('manual')
    try {
      const supabase = createClient()

      // Create outbound message record
      await supabase.from('messages').insert({
        conversation_id: conversationId,
        account_id: accountId,
        channel: channel,
        sender_name: accountName,
        sender_type: 'agent',
        message_text: manualText,
        direction: 'outbound',
        replied: true,
        reply_required: false,
        timestamp: new Date().toISOString(),
        received_at: new Date().toISOString(),
      })

      // Send via n8n (channel-specific)
      const manualActionMap: Record<string, string> = {
        email: 'send_email_reply',
        teams: 'send_teams_reply',
        whatsapp: 'send_whatsapp_reply',
      }
      const res = await fetch('/api/n8n', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: manualActionMap[channel] || 'send_email_reply',
          account_id: accountId,
          data: {
            to: participantEmail,
            subject: emailSubject ? `Re: ${emailSubject}` : 'Re: Your inquiry',
            body: manualText,
            conversation_id: conversationId,
            reply_text: manualText,
            teams_chat_id: teamsChatId || undefined,
          },
        }),
      })

      if (res.ok) {
        toast.success('Manual reply sent!')
        await markWaitingOnCustomer()
      } else {
        toast.warning('Message saved but sending failed.')
      }
      setShowManualReply(false)
      setManualText('')
      router.refresh()
    } catch (err: any) {
      toast.error('Failed: ' + err.message)
    } finally {
      setLoading(null)
    }
  }, [manualText, conversationId, accountId, channel, accountName, participantEmail, router, toast, emailSubject, teamsChatId])

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
            'x-webhook-secret': 'my-webhook-secret-123',
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

  return (
    <div className="sticky bottom-0 bg-white border-t border-gray-200 py-3 px-4 z-10 space-y-3">
      {/* Warning banner — channel-aware */}
      <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
        <Info size={14} className="shrink-0 mt-0.5" />
        <span>
          Replied from {channel === 'teams' ? 'Teams' : channel === 'whatsapp' ? 'WhatsApp' : 'Gmail'} directly? Click <strong>&quot;Mark as Replied&quot;</strong> to sync the status here.
        </span>
      </div>

      {/* Reply compose areas */}
      {showManualReply && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
          <div className="relative">
            <textarea
              ref={manualTextareaRef}
              value={manualText}
              onChange={handleManualTextChange}
              onKeyDown={handleManualTextKeyDown}
              placeholder="Type your reply... (use /shortcut for quick templates)"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 min-h-[100px] resize-y"
              rows={4}
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
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => { setShowManualReply(false); setShortcutQuery(null) }}>
              <X size={14} /> Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={handleManualReply} disabled={loading === 'manual'}>
              {loading === 'manual' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send Reply
            </Button>
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
          <div className="flex gap-2 justify-end">
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
        <Button
          size="sm"
          variant="secondary"
          className="bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200"
          onClick={() => { setShowEditReply(!showEditReply); setShowManualReply(false) }}
          disabled={!aiDraftText}
        >
          <Pencil size={14} />
          Edit &amp; Send
        </Button>
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
