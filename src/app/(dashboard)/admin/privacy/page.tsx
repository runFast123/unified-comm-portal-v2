'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { useToast } from '@/components/ui/toast'
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Download,
  Mail,
  Phone,
  ShieldAlert,
  Trash2,
} from 'lucide-react'

// Response shapes from POST /api/admin/gdpr (the finished contract).
interface ExportCounts {
  conversations: number
  messages: number
  csat: number
  contacts: number
}

interface EraseResult {
  data_subject: { email: string | null; phone: string | null }
  erased: { conversations: number; messages: number; csat: number }
  note?: string
  at: Date
}

export default function PrivacyPage() {
  const { toast } = useToast()

  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [exporting, setExporting] = useState(false)
  const [lastExportCounts, setLastExportCounts] = useState<ExportCounts | null>(null)

  // Erase (danger) flow — modal with type-to-confirm, mirroring the
  // companies-page delete pattern.
  const [eraseOpen, setEraseOpen] = useState(false)
  const [eraseTyped, setEraseTyped] = useState('')
  const [eraseError, setEraseError] = useState<string | null>(null)
  const [erasing, setErasing] = useState(false)
  const [eraseResult, setEraseResult] = useState<EraseResult | null>(null)

  const trimmedEmail = email.trim()
  const trimmedPhone = phone.trim()
  const hasIdentifier = !!trimmedEmail || !!trimmedPhone
  // What the admin must re-type in the danger modal (email wins when both set).
  const confirmTarget = trimmedEmail || trimmedPhone
  // Case-insensitive: the API matches emails case-insensitively too, and a
  // case mismatch here would just dead-lock the danger button with no hint.
  const confirmMatches = eraseTyped.trim().toLowerCase() === confirmTarget.toLowerCase()
  // The erase runs against the UNION of both identifiers — the warning copy
  // must name everything that will match, not just the typed target.
  const eraseScopeLabel = [trimmedEmail, trimmedPhone].filter(Boolean).join('” or “')

  const identifierBody = () => ({
    ...(trimmedEmail ? { email: trimmedEmail } : {}),
    ...(trimmedPhone ? { phone: trimmedPhone } : {}),
  })

  const handleExport = async () => {
    if (!hasIdentifier) return
    setExporting(true)
    try {
      const res = await fetch('/api/admin/gdpr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'export', ...identifierBody() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error || 'Export failed')
        return
      }

      const counts = data.counts as ExportCounts
      setLastExportCounts(counts)

      // Zero matches must NOT read as a completed request — in a DSAR flow
      // that usually means a typo'd identifier, not "no data held".
      const matched =
        counts.conversations > 0 || counts.messages > 0 || counts.csat > 0 || counts.contacts > 0
      if (!matched) {
        toast.warning(
          'No data found for this identifier — nothing to export. Check the spelling, or try the phone number instead.',
          8000
        )
        return
      }

      // Hand the full JSON response to the admin as a downloadable file.
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `gdpr-export-${confirmTarget.replace(/[^a-zA-Z0-9@.+_-]/g, '_')}-${new Date()
        .toISOString()
        .slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)

      toast.success(
        `Export downloaded — ${counts.conversations} conversation${counts.conversations === 1 ? '' : 's'}, ${counts.messages} message${counts.messages === 1 ? '' : 's'}.`
      )
      if (data.truncated) {
        toast.warning(
          'The message list was truncated at 20,000 rows — the export is not complete for this subject.',
          8000
        )
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error during export')
    } finally {
      setExporting(false)
    }
  }

  const openErase = () => {
    if (!hasIdentifier) return
    setEraseTyped('')
    setEraseError(null)
    setEraseOpen(true)
  }

  const closeErase = () => {
    if (erasing) return
    setEraseOpen(false)
  }

  const handleErase = async () => {
    if (!confirmMatches) {
      setEraseError(`Type it to confirm: "${confirmTarget}"`)
      return
    }
    setErasing(true)
    setEraseError(null)
    try {
      const res = await fetch('/api/admin/gdpr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'erase', confirm: true, ...identifierBody() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setEraseError(data?.error || 'Erase failed')
        return
      }
      const erased = data.erased as EraseResult['erased'] | undefined
      const matched =
        (erased?.conversations ?? 0) > 0 || (erased?.messages ?? 0) > 0 || (erased?.csat ?? 0) > 0
      if (!matched) {
        // Nothing matched — keep the form values so the admin can fix the
        // typo, and never frame a no-op as a completed erasure.
        setEraseOpen(false)
        toast.warning(
          'No data found for this identifier — nothing was erased. Check the spelling, or try the phone number instead.',
          8000
        )
        return
      }
      setEraseResult({
        data_subject: data.data_subject,
        erased: data.erased,
        note: data.note,
        at: new Date(),
      })
      setLastExportCounts(null)
      setEraseOpen(false)
      setEmail('')
      setPhone('')
      toast.success(
        `Personal data anonymized — ${erased?.conversations ?? 0} conversation${(erased?.conversations ?? 0) === 1 ? '' : 's'}, ${erased?.messages ?? 0} message${(erased?.messages ?? 0) === 1 ? '' : 's'}.`
      )
    } catch (err) {
      setEraseError(err instanceof Error ? err.message : 'Network error during erase')
    } finally {
      setErasing(false)
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Privacy &amp; data requests</h1>
        <p className="mt-1 text-sm text-gray-500">
          Handle GDPR/CCPA data-subject requests: export everything you hold on a customer, or
          erase it for good. Both actions are recorded in the audit log.
        </p>
      </div>

      {/* Plain-English explainer */}
      <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4">
        <Clock className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
        <div className="text-sm text-blue-900">
          <p className="font-medium">
            A customer can ask for a copy of their data (right of access) or for it to be deleted
            (right to erasure).
          </p>
          <p className="mt-0.5 text-blue-800">
            Under GDPR you have <span className="font-semibold">30 days</span> from the request to
            respond. Everything here is scoped to your company&apos;s accounts only.
          </p>
        </div>
      </div>

      {/* Request form */}
      <Card
        title="Find the customer"
        description="Enter the email and/or phone number the customer used. At least one is required — email matches case-insensitively, phone must match exactly as stored."
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Customer email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@example.com"
              icon={<Mail className="h-4 w-4" />}
              disabled={exporting || erasing}
            />
            <Input
              label="Customer phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+15551234567"
              icon={<Phone className="h-4 w-4" />}
              disabled={exporting || erasing}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              onClick={handleExport}
              disabled={!hasIdentifier || erasing}
              loading={exporting}
            >
              {exporting ? null : <Download className="h-4 w-4" />}
              Export data
            </Button>
            <Button
              variant="danger"
              onClick={openErase}
              disabled={!hasIdentifier || exporting || erasing}
            >
              <Trash2 className="h-4 w-4" />
              Erase data
            </Button>
            {!hasIdentifier && (
              <span className="text-sm text-gray-400">Enter an email or phone to begin.</span>
            )}
          </div>
          {lastExportCounts && (
            <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
              <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              <p>
                Last export matched{' '}
                <span className="font-medium">{lastExportCounts.conversations}</span> conversation
                {lastExportCounts.conversations === 1 ? '' : 's'},{' '}
                <span className="font-medium">{lastExportCounts.messages}</span> message
                {lastExportCounts.messages === 1 ? '' : 's'},{' '}
                <span className="font-medium">{lastExportCounts.csat}</span> CSAT response
                {lastExportCounts.csat === 1 ? '' : 's'} and{' '}
                <span className="font-medium">{lastExportCounts.contacts}</span> contact
                {lastExportCounts.contacts === 1 ? '' : 's'}. The JSON file was downloaded to your
                computer.
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* Erase result summary */}
      {eraseResult && (
        <Card
          title="Erasure completed"
          description={`Finished ${eraseResult.at.toLocaleString()} for ${
            eraseResult.data_subject.email || eraseResult.data_subject.phone || 'the data subject'
          }.`}
        >
          <div className="space-y-3 text-sm text-gray-700">
            <div className="flex items-start gap-2">
              <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              <p>
                Anonymized <span className="font-medium">{eraseResult.erased.conversations}</span>{' '}
                conversation{eraseResult.erased.conversations === 1 ? '' : 's'},{' '}
                <span className="font-medium">{eraseResult.erased.messages}</span> message
                {eraseResult.erased.messages === 1 ? '' : 's'} and{' '}
                <span className="font-medium">{eraseResult.erased.csat}</span> CSAT response
                {eraseResult.erased.csat === 1 ? '' : 's'}.
              </p>
            </div>
            {eraseResult.note && <p className="text-gray-500">{eraseResult.note}</p>}
          </div>
        </Card>
      )}

      {/* Erase confirmation — danger flow with type-to-confirm */}
      <Modal
        open={eraseOpen}
        onClose={closeErase}
        title="Erase customer data"
        footer={
          <>
            <Button variant="secondary" onClick={closeErase} disabled={erasing}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleErase}
              disabled={erasing || !confirmMatches}
              loading={erasing}
            >
              {erasing ? null : <ShieldAlert className="h-4 w-4" />}
              Erase forever
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
            <div className="space-y-1 text-sm text-red-800">
              <p className="font-semibold">This is permanent and cannot be undone.</p>
              <p>
                Across all conversations matching{' '}
                <span className="font-semibold">&ldquo;{eraseScopeLabel}&rdquo;</span>
                {trimmedEmail && trimmedPhone ? ' (both identifiers are matched)' : ''}, this will
                anonymize in place:
              </p>
              <ul className="list-disc space-y-0.5 pl-5">
                <li>Conversation participant name, email, phone and AI summaries</li>
                <li>
                  Message sender names, text, subjects and attachments (replaced with
                  &ldquo;[erased]&rdquo;)
                </li>
                <li>CSAT survey emails and feedback text</li>
                <li>
                  NOT erased: the shared contacts directory entry (it has no per-tenant boundary —
                  left untouched by design)
                </li>
              </ul>
              <p className="mt-2">
                <span className="font-medium">Tip:</span> run &ldquo;Export data&rdquo; first if
                the customer also wants a copy — there is nothing left to export afterwards.
              </p>
            </div>
          </div>

          {eraseError && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {eraseError}
            </div>
          )}

          <Input
            label={`Type "${confirmTarget}" to confirm`}
            placeholder={confirmTarget}
            value={eraseTyped}
            onChange={(e) => setEraseTyped(e.target.value)}
            disabled={erasing}
            autoFocus
          />
        </div>
      </Modal>
    </div>
  )
}
