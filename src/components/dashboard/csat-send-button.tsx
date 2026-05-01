'use client'

// Compact "Send CSAT" button for the conversation header.
// Renders only when the company has CSAT enabled AND the conversation is in
// a sensible terminal state (resolved or waiting_on_customer). Hidden
// otherwise so the action strip stays uncluttered.

import { useState } from 'react'
import { Smile, Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/toast'

interface Props {
  conversationId: string
  /** Server-side gate: only render when true. */
  csatEnabled: boolean
  /** Hide for non-terminal statuses to avoid mid-conversation surveys. */
  status: string | null | undefined
  hasParticipantEmail: boolean
}

const ELIGIBLE_STATUSES = new Set(['resolved', 'waiting_on_customer'])

export function CSATSendButton({
  conversationId,
  csatEnabled,
  status,
  hasParticipantEmail,
}: Props) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)

  if (!csatEnabled) return null
  if (!status || !ELIGIBLE_STATUSES.has(status)) return null

  const disabled = busy || !hasParticipantEmail

  async function send() {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/csat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error || `Send failed (${res.status})`)
        return
      }
      toast.success('CSAT survey sent.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={send}
      disabled={disabled}
      title={
        !hasParticipantEmail
          ? 'No customer email — CSAT survey cannot be sent'
          : 'Email the customer a one-click rating link'
      }
      className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 border border-teal-100 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Smile className="h-3 w-3" />}
      <span>Send CSAT</span>
    </button>
  )
}
