'use client'

import {
  Brain,
  BookOpen,
  History,
  ThumbsUp,
  Pencil,
  X,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  MessageSquare,
  Shield,
  ChevronDown,
  ChevronUp,
  Copy,
  CheckCircle,
} from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn, getSentimentColor, getUrgencyColor } from '@/lib/utils'
import type { MessageClassification, AIReply } from '@/types/database'

export interface AISidebarProps {
  classification: MessageClassification | null
  aiReply: AIReply | null
  kbArticles: string[]
  customerHistory?: {
    id: string
    channel: string
    preview: string
    date: string
  }[]
  onApprove?: (replyId: string) => void
  onEdit?: (replyId: string) => void
  onDismiss?: (replyId: string) => void
}

function SidebarSection({
  title,
  icon: Icon,
  children,
  defaultOpen = true,
}: {
  title: string
  icon: React.ElementType
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-3 hover:bg-gray-50 transition-colors"
      >
        <Icon size={16} className="text-teal-700" />
        <h3 className="flex-1 text-left text-sm font-semibold text-gray-900">{title}</h3>
        {open ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
      </button>
      {open && <div className="border-t border-gray-100 px-4 py-3">{children}</div>}
    </div>
  )
}

function SentimentIcon({ sentiment }: { sentiment: string }) {
  switch (sentiment) {
    case 'positive': return <TrendingUp size={12} />
    case 'negative': return <TrendingDown size={12} />
    default: return <Minus size={12} />
  }
}

/** Render AI draft text with basic markdown-like formatting */
function FormattedDraft({ text }: { text: string }) {
  if (!text) return null

  const lines = text.split('\n')
  const elements: React.ReactNode[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Bold headers like **Subject:** or ### Heading
    if (line.match(/^\*\*.*\*\*$/)) {
      elements.push(
        <p key={i} className="font-semibold text-gray-900 text-xs mt-2">
          {line.replace(/\*\*/g, '')}
        </p>
      )
      continue
    }

    // Markdown headers
    if (line.match(/^#{1,3}\s/)) {
      elements.push(
        <p key={i} className="font-semibold text-gray-900 text-xs mt-2">
          {line.replace(/^#{1,3}\s/, '')}
        </p>
      )
      continue
    }

    // Horizontal rule
    if (line.match(/^---+$/)) {
      elements.push(<hr key={i} className="my-1.5 border-gray-200" />)
      continue
    }

    // List items
    if (line.match(/^[-*]\s/) || line.match(/^\d+\.\s/)) {
      elements.push(
        <div key={i} className="flex gap-1.5 text-xs text-gray-700 pl-1">
          <span className="text-gray-400 shrink-0">•</span>
          <span>{line.replace(/^[-*]\s|^\d+\.\s/, '').replace(/\*\*/g, '')}</span>
        </div>
      )
      continue
    }

    // Table rows (skip for brevity in sidebar)
    if (line.startsWith('|')) {
      continue
    }

    // Empty line
    if (!line.trim()) {
      elements.push(<div key={i} className="h-1" />)
      continue
    }

    // Regular text - strip markdown bold
    elements.push(
      <p key={i} className="text-xs text-gray-700 leading-relaxed">
        {line.replace(/\*\*/g, '').replace(/\*/g, '')}
      </p>
    )
  }

  return <div className="space-y-0.5">{elements}</div>
}

export function AISidebar({
  classification,
  aiReply,
  kbArticles,
  customerHistory = [],
  onApprove,
  onEdit,
  onDismiss,
}: AISidebarProps) {
  const [draftExpanded, setDraftExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopyDraft = async () => {
    if (!aiReply?.draft_text) return
    try {
      await navigator.clipboard.writeText(aiReply.draft_text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = aiReply.draft_text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="space-y-3">
      {/* Classification card */}
      {classification && (
        <SidebarSection title="AI Classification" icon={Brain}>
          <div className="space-y-3">
            {/* Category & Subcategory row */}
            <div className="flex flex-wrap gap-2">
              <div className="flex-1 min-w-0">
                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Category</span>
                <div className="mt-1">
                  <Badge variant="info" size="md">{classification.category}</Badge>
                </div>
              </div>
              {classification.subcategory && (
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Subcategory</span>
                  <div className="mt-1">
                    <Badge variant="default" size="sm">{classification.subcategory}</Badge>
                  </div>
                </div>
              )}
            </div>

            {/* Sentiment & Urgency row */}
            <div className="flex gap-2">
              <div className="flex-1 rounded-lg bg-gray-50 p-2">
                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Sentiment</span>
                <div className="mt-1">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                      getSentimentColor(classification.sentiment)
                    )}
                  >
                    <SentimentIcon sentiment={classification.sentiment} />
                    {classification.sentiment}
                  </span>
                </div>
              </div>
              <div className="flex-1 rounded-lg bg-gray-50 p-2">
                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Urgency</span>
                <div className="mt-1">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                      getUrgencyColor(classification.urgency)
                    )}
                  >
                    <AlertTriangle size={11} />
                    {classification.urgency}
                  </span>
                </div>
              </div>
            </div>

            {/* Topic summary */}
            {classification.topic_summary && (
              <div className="rounded-lg bg-blue-50 p-2.5">
                <span className="text-[10px] font-medium text-blue-500 uppercase tracking-wider">Summary</span>
                <p className="mt-1 text-xs text-gray-700 leading-relaxed">{classification.topic_summary}</p>
              </div>
            )}

            {/* Confidence bar */}
            {classification.confidence != null && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider flex items-center gap-1">
                    <Shield size={10} /> Confidence
                  </span>
                  <span className="text-xs font-bold text-gray-700">
                    {Math.round(Number(classification.confidence) * 100)}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className={cn(
                      'h-1.5 rounded-full transition-all',
                      Number(classification.confidence) > 0.8 ? 'bg-green-500' :
                      Number(classification.confidence) >= 0.6 ? 'bg-yellow-500' : 'bg-red-500'
                    )}
                    style={{ width: `${Math.round(Number(classification.confidence) * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </SidebarSection>
      )}

      {/* AI Draft card */}
      {aiReply && (
        <SidebarSection title="AI Draft Reply" icon={Sparkles}>
          <div className="space-y-3">
            {/* Status badge & copy button */}
            <div className="flex items-center justify-between">
              <Badge
                variant={aiReply.status === 'pending_approval' ? 'warning' : aiReply.status === 'sent' ? 'success' : 'info'}
                size="sm"
              >
                {aiReply.status === 'pending_approval' ? 'Pending Review' :
                 aiReply.status === 'sent' ? 'Sent' :
                 aiReply.status === 'approved' ? 'Approved' :
                 aiReply.status}
              </Badge>
              <button
                onClick={handleCopyDraft}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                  copied
                    ? 'bg-green-50 text-green-600 border border-green-200'
                    : 'bg-gray-50 text-gray-500 hover:bg-gray-100 hover:text-gray-700 border border-gray-200'
                )}
                title="Copy draft to clipboard"
              >
                {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
                {copied ? 'Copied!' : 'Copy Draft'}
              </button>
            </div>

            {/* Draft text with expand/collapse */}
            <div className="rounded-lg border border-purple-100 bg-gradient-to-b from-purple-50 to-white overflow-hidden">
              <div className={cn(
                'px-3 py-2.5 transition-all',
                !draftExpanded && 'max-h-[150px] overflow-hidden relative'
              )}>
                <FormattedDraft text={aiReply.draft_text || ''} />
                {!draftExpanded && (
                  <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-purple-50 to-transparent" />
                )}
              </div>
              <button
                onClick={() => setDraftExpanded(!draftExpanded)}
                className="w-full px-3 py-1.5 text-[10px] font-medium text-purple-600 hover:bg-purple-50 border-t border-purple-100 transition-colors"
              >
                {draftExpanded ? 'Show Less' : 'Show Full Draft'}
              </button>
            </div>

            {/* Action buttons */}
            {aiReply.status === 'pending_approval' && (
              <div className="flex gap-2">
                <Button size="sm" variant="primary" className="flex-1" onClick={() => onApprove?.(aiReply.id)}>
                  <ThumbsUp size={13} />
                  Approve
                </Button>
                <Button size="sm" variant="secondary" className="flex-1" onClick={() => onEdit?.(aiReply.id)}>
                  <Pencil size={13} />
                  Edit
                </Button>
                <Button size="sm" variant="ghost" className="px-2" onClick={() => onDismiss?.(aiReply.id)}>
                  <X size={13} />
                </Button>
              </div>
            )}
          </div>
        </SidebarSection>
      )}

      {/* KB Articles */}
      {kbArticles.length > 0 && (
        <SidebarSection title="KB Articles Used" icon={BookOpen}>
          <ul className="space-y-2">
            {kbArticles.map((article) => (
              <li key={article} className="flex items-start gap-2">
                <BookOpen size={14} className="mt-0.5 shrink-0 text-gray-400" />
                <span className="text-sm text-gray-700 hover:text-teal-700 cursor-pointer">
                  {article}
                </span>
              </li>
            ))}
          </ul>
        </SidebarSection>
      )}

      {/* Customer History */}
      {customerHistory.length > 0 && (
        <SidebarSection title="Customer History" icon={History} defaultOpen={false}>
          <ul className="space-y-2">
            {customerHistory.map(item => (
              <li key={item.id}>
                <a
                  href={'/conversations/' + item.id}
                  className="flex items-start gap-2 rounded-lg p-2 hover:bg-gray-50 cursor-pointer transition-colors no-underline"
                >
                  <MessageSquare size={13} className="mt-0.5 shrink-0 text-gray-400" />
                  <div className="min-w-0">
                    <p className="text-xs text-gray-700 truncate hover:text-teal-700 transition-colors">{item.preview}</p>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-gray-400">
                      <span>{item.channel}</span>
                      <span>&middot;</span>
                      <span>{item.date}</span>
                    </div>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </SidebarSection>
      )}
    </div>
  )
}
