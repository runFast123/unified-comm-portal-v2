'use client'

import { Bot, Check, CheckCheck, Mail, Paperclip, Clock, Sparkles, FileText, FileSpreadsheet, FileImage, File, Download } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Message, ChannelType } from '@/types/database'

export interface ConversationThreadProps {
  messages: Message[]
  channel: ChannelType
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatRelativeTime(timestamp: string): string {
  const now = Date.now()
  const then = new Date(timestamp).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin} min ago`
  if (diffHr < 24) return `${diffHr} hour${diffHr > 1 ? 's' : ''} ago`
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ─── Attachment helpers ───────────────────────────────────────

interface AttachmentItem {
  filename?: string
  name?: string
  mimeType?: string
  mime_type?: string
  size?: number
  url?: string
  data?: string
  attachmentId?: string
  contentType?: string
}

function getFileIcon(filename: string, mimeType?: string) {
  const ext = (filename || '').split('.').pop()?.toLowerCase() || ''
  const mime = (mimeType || '').toLowerCase()

  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext))
    return <FileImage className="h-4 w-4 text-purple-500" />
  if (mime.includes('spreadsheet') || mime.includes('excel') || ['xlsx', 'xls', 'csv'].includes(ext))
    return <FileSpreadsheet className="h-4 w-4 text-green-600" />
  if (mime.includes('pdf') || ext === 'pdf')
    return <FileText className="h-4 w-4 text-red-500" />
  if (mime.includes('word') || mime.includes('document') || ['doc', 'docx'].includes(ext))
    return <FileText className="h-4 w-4 text-blue-600" />
  return <File className="h-4 w-4 text-gray-500" />
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function renderAttachments(attachments: unknown) {
  let items: AttachmentItem[] = []

  if (Array.isArray(attachments)) {
    // Filter to only real file attachments (must have filename or name)
    items = attachments.filter((att: any) =>
      att && (att.filename || att.name || att.url || att.contentUrl)
    )
  } else if (typeof attachments === 'object' && attachments !== null) {
    const obj = attachments as Record<string, unknown>
    // Skip metadata objects (team_name, channel_name, is_reply, etc.) — NOT real attachments
    if (obj.filename || obj.name || obj.url || obj.contentUrl) {
      items = [obj as AttachmentItem]
    }
    // If it has an "attachments" sub-array (legacy format), extract those
    if (Array.isArray(obj.attachments)) {
      items = (obj.attachments as AttachmentItem[]).filter((att: any) =>
        att && (att.filename || att.name || att.url || att.contentUrl)
      )
    }
  }

  if (items.length === 0) return null

  return (
    <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/50">
      <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
        <Paperclip size={11} />
        <span>{items.length} Attachment{items.length > 1 ? 's' : ''}</span>
      </div>
      <div className="space-y-1.5">
        {items.map((att, i) => {
          const name = att.filename || att.name || `Attachment ${i + 1}`
          const mime = att.mimeType || att.mime_type || att.contentType || ''
          const size = att.size
          const url = att.url || (att.data ? `data:${mime};base64,${att.data}` : '')

          const isImage = mime.startsWith('image/') || ['png','jpg','jpeg','gif','webp','svg'].includes((name.split('.').pop() || '').toLowerCase())

          // Inline image preview
          if (isImage && url) {
            return (
              <div key={i} className="rounded-lg border border-gray-200 bg-white overflow-hidden hover:shadow-sm transition-all">
                <a href={url} target="_blank" rel="noopener noreferrer">
                  <img src={url} alt={name} className="max-h-48 w-auto rounded-t-lg object-contain bg-gray-50" loading="lazy" />
                </a>
                <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-500">
                  <FileImage className="h-3 w-3" />
                  <span className="truncate">{name}</span>
                  {size ? <span className="shrink-0">{formatFileSize(size)}</span> : null}
                </div>
              </div>
            )
          }

          return (
            <div
              key={i}
              className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2.5 hover:border-gray-300 hover:shadow-sm transition-all group"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-100 shrink-0">
                {getFileIcon(name, mime)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{name}</p>
                <p className="text-xs text-gray-400">
                  {mime.split('/').pop()?.toUpperCase() || 'FILE'}
                  {size ? ` · ${formatFileSize(size)}` : ''}
                </p>
              </div>
              {url ? (
                <a
                  href={url}
                  download={name}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:text-teal-600 hover:bg-teal-50 transition-colors opacity-0 group-hover:opacity-100"
                  title={`Download ${name}`}
                >
                  <Download className="h-4 w-4" />
                </a>
              ) : (
                <span className="text-[10px] text-gray-500 px-2">No link</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

/** Parse sender display name from "Name" <email> format */
function parseSender(sender: string | null): { name: string; email: string } {
  if (!sender) return { name: 'Unknown', email: '' }
  const match = sender.match(/^"?([^"<]+)"?\s*<?([^>]*)>?$/)
  if (match) {
    return { name: match[1].trim(), email: match[2]?.trim() || sender }
  }
  return { name: sender, email: sender }
}

/** Format email body - clean up quoted text, signatures, and formatting */
function formatEmailBody(text: string | null): React.ReactNode {
  if (!text) return <span className="text-gray-500 italic">No content</span>

  // Split into main body and quoted sections
  const lines = text.split('\n')
  const mainLines: string[] = []
  const quotedLines: string[] = []
  let inQuote = false

  for (const line of lines) {
    if (line.startsWith('>') || (line.match(/^On .+ wrote:$/) && !inQuote)) {
      inQuote = true
    }
    if (inQuote) {
      quotedLines.push(line.replace(/^>\s?/, ''))
    } else {
      mainLines.push(line)
    }
  }

  // Clean up main body - remove excessive blank lines
  const cleanBody = mainLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // Detect form-like content (key: value pairs)
  const formPattern = /^\*([^*]+)\*$/
  const bodyParts = cleanBody.split('\n')
  const formattedParts: React.ReactNode[] = []
  let i = 0

  while (i < bodyParts.length) {
    const line = bodyParts[i]
    const formMatch = line.match(formPattern)

    if (formMatch && i + 1 < bodyParts.length && !bodyParts[i + 1].match(formPattern)) {
      // This is a label followed by a value
      formattedParts.push(
        <div key={i} className="flex flex-col sm:flex-row sm:gap-2 py-1">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide min-w-[140px]">
            {formMatch[1].replace(/\(Optional\)/i, '').trim()}
          </span>
          <span className="text-sm text-gray-900 font-medium">{bodyParts[i + 1]}</span>
        </div>
      )
      i += 2
      continue
    }

    if (line === '---') {
      formattedParts.push(<hr key={i} className="my-2 border-gray-200" />)
      i++
      continue
    }

    if (line.trim()) {
      // Check if it's a signature line
      const isSignature = line.startsWith('Sent from') || line.startsWith('This message was sent from')
      formattedParts.push(
        <p key={i} className={cn('text-sm leading-relaxed', isSignature ? 'text-gray-400 italic text-xs mt-2' : 'text-gray-800')}>
          {line}
        </p>
      )
    } else if (formattedParts.length > 0) {
      formattedParts.push(<div key={i} className="h-2" />)
    }
    i++
  }

  return (
    <div>
      <div className="space-y-0.5">{formattedParts}</div>
      {quotedLines.length > 0 && (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 rounded-md hover:bg-gray-100 px-2 py-1 -mx-2 transition-colors">
            <span className="group-open:hidden">
              &ldquo;{quotedLines[0]?.substring(0, 80)}{quotedLines[0]?.length > 80 ? '...' : ''}&rdquo;
              <span className="ml-1 text-gray-300">+{quotedLines.length} lines</span>
            </span>
            <span className="hidden group-open:inline">Hide quoted text</span>
          </summary>
          <div className="mt-2 border-l-2 border-gray-200 pl-3 text-xs text-gray-400 whitespace-pre-wrap max-h-[200px] overflow-y-auto">
            {quotedLines.join('\n')}
          </div>
        </details>
      )}
    </div>
  )
}

// WhatsApp delivery status icon
function DeliveryStatus({ sent }: { sent: boolean }) {
  return sent ? (
    <CheckCheck size={14} className="text-blue-400" />
  ) : (
    <Check size={14} className="text-gray-400" />
  )
}

// AI indicator badge
function AIBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-purple-100 to-violet-100 border border-purple-200 px-2 py-0.5 text-[10px] font-bold text-purple-700 shadow-sm">
      <Sparkles size={10} className="text-purple-500" />
      AI
    </span>
  )
}

function EmailMessage({ message, isOutbound }: { message: Message; isOutbound: boolean }) {
  const { name, email } = parseSender(message.sender_name)
  const initials = name.split(' ').filter(Boolean).map(w => w[0]).join('').substring(0, 2).toUpperCase() || 'U'

  return (
    <div className={cn('max-w-[90%]', isOutbound ? 'ml-auto' : 'mr-auto')}>
      <div
        className={cn(
          'rounded-xl border shadow-sm overflow-hidden',
          isOutbound
            ? 'border-teal-200 bg-gradient-to-b from-teal-50 to-white'
            : 'border-gray-200 bg-white'
        )}
      >
        {/* Email header */}
        <div className={cn(
          'px-4 py-3 border-b',
          isOutbound ? 'border-teal-100 bg-teal-50/50' : 'border-gray-100 bg-gray-50/50'
        )}>
          <div className="flex items-start gap-3">
            <div className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white',
              isOutbound ? 'bg-teal-600' : 'bg-indigo-500'
            )}>
              {initials || 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-gray-900 truncate">{name}</span>
                {message.sender_type === 'ai' && <AIBadge />}
              </div>
              {email && email !== name && (
                <span className="text-xs text-gray-400 truncate block">{email}</span>
              )}
              {message.email_subject && (
                <div className="flex items-center gap-1.5 mt-1">
                  <Mail size={11} className="text-gray-400 shrink-0" />
                  <span className="text-xs font-medium text-gray-600 truncate">
                    {message.email_subject}
                  </span>
                </div>
              )}
            </div>
            <div className="flex flex-col items-end gap-0.5 shrink-0">
              <span className="text-[11px] font-medium text-gray-500">{formatRelativeTime(message.timestamp)}</span>
              <span className="text-[10px] text-gray-400 flex items-center gap-1">
                <Clock size={9} />
                {formatTime(message.timestamp)}
              </span>
            </div>
          </div>
        </div>

        {/* Email body */}
        <div className="px-4 py-3">
          {formatEmailBody(message.message_text)}
        </div>

        {/* Attachments */}
        {message.attachments && renderAttachments(message.attachments)}
      </div>
    </div>
  )
}

function cleanSenderName(raw: string | null): string {
  if (!raw) return 'Unknown'
  return raw
    .replace(/<[^>]+>/g, '')       // strip HTML tags
    .replace(/^["']+|["']+$/g, '') // strip surrounding quotes
    .replace(/\s*\.\s*$/, '')      // strip trailing dot
    .replace(/\s+/g, ' ')          // normalize spaces
    .trim() || 'Unknown'
}

function TeamsBubble({ message, isOutbound }: { message: Message; isOutbound: boolean }) {
  const senderName = cleanSenderName(message.sender_name)
  const initials = senderName.split(' ').filter(Boolean).map(w => w[0]).join('').substring(0, 2).toUpperCase() || 'U'

  return (
    <div className={cn('flex gap-3 max-w-[85%]', isOutbound ? 'ml-auto flex-row-reverse' : 'mr-auto')}>
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm',
          isOutbound ? 'bg-[#6264a7]' : 'bg-gradient-to-br from-gray-400 to-gray-500'
        )}
      >
        {initials}
      </div>

      <div className="min-w-0 flex-1">
        <div className={cn('mb-1 flex items-center gap-2', isOutbound ? 'justify-end' : 'justify-start')}>
          <span className="text-xs font-semibold text-gray-700">{senderName}</span>
          {message.sender_type === 'ai' && <AIBadge />}
          <span className="text-[10px] text-gray-400">{formatRelativeTime(message.timestamp)}</span>
        </div>

        <div
          className={cn(
            'rounded-xl px-4 py-3 shadow-sm',
            isOutbound
              ? 'bg-gradient-to-br from-[#e8e8f5] to-[#ddddf5] border border-[#d0d0e8]'
              : 'bg-white border border-gray-200'
          )}
        >
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-gray-900">{message.message_text}</p>
          {message.attachments && renderAttachments(message.attachments)}
        </div>
      </div>
    </div>
  )
}

function WhatsAppBubble({ message, isOutbound }: { message: Message; isOutbound: boolean }) {
  const senderName = cleanSenderName(message.sender_name)
  return (
    <div className={cn('max-w-[75%]', isOutbound ? 'ml-auto' : 'mr-auto')}>
      {!isOutbound && (
        <span className="mb-0.5 block text-xs font-medium text-teal-700">
          {senderName}
          {message.sender_type === 'ai' && <> <AIBadge /></>}
        </span>
      )}

      <div
        className={cn(
          'relative rounded-lg px-3 py-2',
          isOutbound ? 'bg-[#dcf8c6]' : 'bg-white border border-gray-200',
          isOutbound ? 'rounded-tr-none' : 'rounded-tl-none'
        )}
      >
        <p className="text-sm leading-relaxed text-gray-900 whitespace-pre-wrap">
          {message.message_text}
        </p>
        {message.attachments && renderAttachments(message.attachments)}
        <div className="mt-1 flex items-center justify-end gap-1.5">
          <span className="text-[10px] text-gray-500" title={formatTime(message.timestamp)}>{formatRelativeTime(message.timestamp)}</span>
          {isOutbound && <DeliveryStatus sent={true} />}
        </div>
      </div>
    </div>
  )
}

export function ConversationThread({ messages, channel }: ConversationThreadProps) {
  let lastDate = ''
  let prevDirection: string | null = null
  let prevTimestamp: string | null = null

  return (
    <div className="space-y-3 py-4">
      {messages.map((message, idx) => {
        const isOutbound = message.direction === 'outbound'
        const msgDate = formatDate(message.timestamp)
        const showDateSep = msgDate !== lastDate
        lastDate = msgDate

        // Response time indicator — show when direction changes (customer→agent or agent→customer)
        let responseTimeIndicator: React.ReactNode = null
        if (prevDirection && prevDirection !== message.direction && prevTimestamp) {
          const gapMs = new Date(message.timestamp).getTime() - new Date(prevTimestamp).getTime()
          if (gapMs > 60000) { // Only show if gap > 1 minute
            const gapMins = Math.floor(gapMs / 60000)
            let gapText = ''
            if (gapMins < 60) gapText = `${gapMins}m`
            else if (gapMins < 1440) gapText = `${Math.floor(gapMins / 60)}h ${gapMins % 60}m`
            else gapText = `${Math.floor(gapMins / 1440)}d ${Math.floor((gapMins % 1440) / 60)}h`

            const isAgentReply = message.direction === 'outbound'
            const label = isAgentReply ? `Agent replied in ${gapText}` : `Customer replied after ${gapText}`
            const gapColor = gapMins < 60 ? 'text-green-500 bg-green-50 border-green-200' : gapMins < 240 ? 'text-amber-500 bg-amber-50 border-amber-200' : 'text-red-500 bg-red-50 border-red-200'

            responseTimeIndicator = (
              <div className="flex justify-center py-1">
                <span className={cn('inline-flex items-center gap-1 rounded-full px-3 py-0.5 text-[10px] font-medium border', gapColor)}>
                  <Clock size={10} />
                  {label}
                </span>
              </div>
            )
          }
        }
        prevDirection = message.direction
        prevTimestamp = message.timestamp

        return (
          <div key={message.id}>
            {showDateSep && (
              <div className="flex items-center gap-3 py-3">
                <div className="h-px flex-1 bg-gray-200" />
                <span className="text-xs font-medium text-gray-400">{msgDate}</span>
                <div className="h-px flex-1 bg-gray-200" />
              </div>
            )}

            {responseTimeIndicator}

            {channel === 'email' && (
              <EmailMessage message={message} isOutbound={isOutbound} />
            )}
            {channel === 'teams' && (
              <TeamsBubble message={message} isOutbound={isOutbound} />
            )}
            {channel === 'whatsapp' && (
              <WhatsAppBubble message={message} isOutbound={isOutbound} />
            )}
          </div>
        )
      })}
    </div>
  )
}
