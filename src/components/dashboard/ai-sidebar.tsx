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
import { Modal } from '@/components/ui/modal'
import { cn, getSentimentColor, getUrgencyColor } from '@/lib/utils'
import type { MessageClassification, AIReply } from '@/types/database'
import { ThreadSummary } from '@/components/dashboard/thread-summary'
import { useUser } from '@/context/user-context'

export interface SentimentPoint {
  sentiment: 'positive' | 'neutral' | 'negative'
  timestamp: string
  preview: string
}

export interface AISidebarProps {
  classification: MessageClassification | null
  aiReply: AIReply | null
  kbArticles: string[]
  sentimentHistory?: SentimentPoint[]
  customerHistory?: {
    id: string
    channel: string
    preview: string
    date: string
  }[]
  channel?: string
  teamsContext?: {
    chatType: '1:1' | 'group'
    accountName: string
    participantName: string
    messageCount: number
  } | null
  /** When provided, renders a "Summarize thread" AI action at the top of the sidebar. */
  conversationId?: string
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
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-3 hover:bg-muted transition-colors"
      >
        <Icon size={16} className="text-teal-700" />
        <h3 className="flex-1 text-left text-sm font-semibold text-foreground">{title}</h3>
        {open ? <ChevronUp size={14} className="text-zinc-500" /> : <ChevronDown size={14} className="text-zinc-500" />}
      </button>
      {open && <div className="border-t border-border px-4 py-4">{children}</div>}
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
        <p key={i} className="font-semibold text-foreground text-xs mt-2">
          {line.replace(/\*\*/g, '')}
        </p>
      )
      continue
    }

    // Markdown headers
    if (line.match(/^#{1,3}\s/)) {
      elements.push(
        <p key={i} className="font-semibold text-foreground text-xs mt-2">
          {line.replace(/^#{1,3}\s/, '')}
        </p>
      )
      continue
    }

    // Horizontal rule
    if (line.match(/^---+$/)) {
      elements.push(<hr key={i} className="my-1.5 border-border" />)
      continue
    }

    // List items
    if (line.match(/^[-*]\s/) || line.match(/^\d+\.\s/)) {
      elements.push(
        <div key={i} className="flex gap-1.5 text-xs text-zinc-700 pl-1">
          <span className="text-zinc-500 shrink-0">•</span>
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
      <p key={i} className="text-xs text-zinc-700 leading-relaxed">
        {line.replace(/\*\*/g, '').replace(/\*/g, '')}
      </p>
    )
  }

  return <div className="space-y-0.5">{elements}</div>
}

function SentimentSection({ trendLabel, trendColor, TrendIcon, trend, posCount, neuCount, negCount, total, sentimentHistory }: {
  trendLabel: string; trendColor: string; TrendIcon: React.ElementType; trend: number
  posCount: number; neuCount: number; negCount: number; total: number; sentimentHistory: SentimentPoint[]
}) {
  const [showDetails, setShowDetails] = useState(false)

  return (
    <div className="rounded-xl border border-border bg-card overflow-visible">
      {/* Clickable header + bar — entire section is one click target */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className={cn(
          'w-full text-left p-3 space-y-3 rounded-xl transition-all cursor-pointer',
          'hover:bg-muted'
        )}
      >
        {/* Title */}
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-zinc-500" />
          <span className="text-sm font-semibold text-zinc-700 flex-1">Customer Sentiment</span>
          <ChevronDown className={cn('h-4 w-4 text-zinc-500 transition-transform', showDetails && 'rotate-180')} />
        </div>

        {/* Trend indicator */}
        <div className={cn('flex items-center gap-2 rounded-lg px-3 py-2', trend < -0.3 ? 'bg-red-50 border border-red-200' : trend > 0.3 ? 'bg-green-50 border border-green-200' : 'bg-muted border border-border')}>
          <TrendIcon className={cn('h-5 w-5', trendColor)} />
          <div>
            <p className={cn('text-sm font-semibold', trendColor)}>{trendLabel}</p>
            <p className="text-xs text-muted-foreground">{total} messages analyzed</p>
          </div>
          {trend < -0.3 && (
            <Badge variant="danger" size="sm" className="ml-auto">At Risk</Badge>
          )}
        </div>

        {/* Sentiment bar */}
        <div>
          <div className="flex items-center gap-1 h-4 rounded-full overflow-hidden bg-muted">
            {posCount > 0 && <div className="h-full bg-green-500" style={{ width: `${(posCount / total) * 100}%` }} />}
            {neuCount > 0 && <div className="h-full bg-zinc-400" style={{ width: `${(neuCount / total) * 100}%` }} />}
            {negCount > 0 && <div className="h-full bg-red-500" style={{ width: `${(negCount / total) * 100}%` }} />}
          </div>
          <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-500" /> {posCount} positive</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-zinc-400" /> {neuCount} neutral</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" /> {negCount} negative</span>
          </div>
        </div>

      </button>

      {/* Floating table window — routed through the shared <Modal> so it inherits
          the focus trap, Escape, scroll-lock, and role="dialog"/aria-modal
          wiring. The bespoke header/table/footer render full-bleed via
          bodyClassName="p-0"; Modal owns the backdrop + centering. */}
      <Modal
        open={showDetails}
        onClose={() => setShowDetails(false)}
        ariaLabel="Sentiment analysis details"
        className="overflow-hidden max-h-[70vh]"
        bodyClassName="p-0"
      >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-muted">
              <h3 className="text-sm font-bold text-zinc-700">Sentiment Analysis Details</h3>
              <button onClick={() => setShowDetails(false)} className="rounded-full p-1 hover:bg-zinc-200 text-zinc-500 hover:text-zinc-700 transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Table */}
            <div className="overflow-y-auto max-h-[55vh]">
              <table className="w-full text-sm">
                <thead className="bg-muted sticky top-0">
                  <tr>
                    <th className="text-left px-5 py-2.5 text-xs font-semibold text-zinc-500 uppercase w-24">Sentiment</th>
                    <th className="text-left px-5 py-2.5 text-xs font-semibold text-zinc-500 uppercase">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sentimentHistory.map((s, i) => (
                    <tr key={i} className={cn(
                      'transition-colors',
                      s.sentiment === 'positive' ? 'hover:bg-green-50' : s.sentiment === 'negative' ? 'hover:bg-red-50' : 'hover:bg-muted'
                    )}>
                      <td className="px-5 py-3">
                        <span className={cn(
                          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
                          s.sentiment === 'positive' ? 'bg-green-100 text-green-700' :
                          s.sentiment === 'negative' ? 'bg-red-100 text-red-700' :
                          'bg-zinc-100 text-zinc-600'
                        )}>
                          <span className={cn('h-2 w-2 rounded-full',
                            s.sentiment === 'positive' ? 'bg-green-500' : s.sentiment === 'negative' ? 'bg-red-500' : 'bg-zinc-400'
                          )} />
                          {s.sentiment === 'positive' ? 'Positive' : s.sentiment === 'negative' ? 'Negative' : 'Neutral'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-xs text-zinc-700 leading-relaxed">
                        {s.preview}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Footer summary */}
            <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-muted text-xs text-zinc-500">
              <span>{total} messages total</span>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-500" /> {posCount}</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-zinc-400" /> {neuCount}</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" /> {negCount}</span>
              </div>
            </div>
      </Modal>
    </div>
  )
}

export function AISidebar({
  classification,
  aiReply,
  kbArticles,
  sentimentHistory = [],
  customerHistory = [],
  channel,
  teamsContext,
  conversationId,
}: AISidebarProps) {
  const { can } = useUser()
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
    <div className="space-y-4">
      {/* AI-generated thread summary (on-demand) */}
      {conversationId && can('action:ai.summarize') && <ThreadSummary conversationId={conversationId} />}

      {/* Teams Context Card */}
      {channel === 'teams' && teamsContext && (
        <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-4">
          <div className="flex items-center gap-2 mb-2">
            <svg className="h-4 w-4 text-[var(--color-teams)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span className="text-xs font-bold text-zinc-700 uppercase tracking-wider">Teams Chat</span>
          </div>
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Type</span>
              <span className="font-semibold text-zinc-900">
                {teamsContext.chatType === '1:1' ? '1:1 Direct Message' : 'Group Chat'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Account</span>
              <span className="font-medium text-zinc-900">{teamsContext.accountName}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Contact</span>
              <span className="font-medium text-zinc-900">{teamsContext.participantName}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Messages</span>
              <span className="font-medium text-zinc-900">{teamsContext.messageCount} in this chat</span>
            </div>
          </div>
        </div>
      )}

      {/* Conversation Summary */}
      {classification?.topic_summary && (
        <div className="rounded-xl bg-teal-50 border border-teal-200 p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <Sparkles className="h-4 w-4 text-teal-700" />
            <span className="text-xs font-bold text-teal-800 uppercase tracking-wider">Summary</span>
          </div>
          <p className="text-sm text-teal-900 leading-relaxed">{classification.topic_summary}</p>
        </div>
      )}

      {/* Classification card */}
      {classification && (
        <SidebarSection title="AI Classification" icon={Brain}>
          <div className="space-y-3">
            {/* Category & Subcategory row */}
            <div className="flex flex-wrap gap-2">
              <div className="flex-1 min-w-0">
                <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Category</span>
                <div className="mt-1">
                  <Badge variant="info" size="md">{classification.category}</Badge>
                </div>
              </div>
              {classification.subcategory && (
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Subcategory</span>
                  <div className="mt-1">
                    <Badge variant="default" size="sm">{classification.subcategory}</Badge>
                  </div>
                </div>
              )}
            </div>

            {/* Sentiment & Urgency row */}
            <div className="flex gap-2">
              <div className="flex-1 rounded-lg bg-muted p-2">
                <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Sentiment</span>
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
              <div className="flex-1 rounded-lg bg-muted p-2">
                <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Urgency</span>
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

            {/* Confidence bar */}
            {classification.confidence != null && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider flex items-center gap-1">
                    <Shield size={10} /> Confidence
                  </span>
                  <span className="text-xs font-bold text-zinc-700">
                    {Math.round(Number(classification.confidence) * 100)}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
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
                    ? 'bg-green-50 text-green-700 border border-green-200'
                    : 'bg-muted text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 border border-border'
                )}
                title="Copy draft to clipboard"
              >
                {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
                {copied ? 'Copied!' : 'Copy Draft'}
              </button>
            </div>

            {/* Draft text with expand/collapse */}
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 overflow-hidden">
              <div className={cn(
                'px-3 py-2.5 transition-all',
                !draftExpanded && 'max-h-[150px] overflow-hidden relative'
              )}>
                <FormattedDraft text={aiReply.draft_text || ''} />
                {!draftExpanded && (
                  <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-zinc-50 to-transparent" />
                )}
              </div>
              <button
                onClick={() => setDraftExpanded(!draftExpanded)}
                className="w-full px-3 py-1.5 text-[10px] font-medium text-teal-700 hover:bg-teal-50 border-t border-zinc-200 transition-colors"
              >
                {draftExpanded ? 'Show Less' : 'Show Full Draft'}
              </button>
            </div>

            {/* Hint for pending drafts */}
            {aiReply.status === 'pending_approval' && (
              <p className="text-[10px] text-center text-teal-600 bg-teal-50 rounded-lg py-1.5 mt-1">
                Use the action bar below to approve, edit, or send this draft
              </p>
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
                <BookOpen size={14} className="mt-0.5 shrink-0 text-zinc-500" />
                <span className="text-sm text-zinc-700 hover:text-teal-700 cursor-pointer">
                  {article}
                </span>
              </li>
            ))}
          </ul>
        </SidebarSection>
      )}

      {/* Customer Sentiment Trend */}
      {sentimentHistory.length >= 2 && (() => {
        const sentimentValues: number[] = sentimentHistory.map(s => s.sentiment === 'positive' ? 1 : s.sentiment === 'negative' ? -1 : 0)
        const recent = sentimentValues.slice(-3)
        const earlier = sentimentValues.slice(0, Math.max(1, sentimentValues.length - 3))
        const recentAvg = recent.reduce((a: number, b: number) => a + b, 0) / recent.length
        const earlierAvg = earlier.reduce((a: number, b: number) => a + b, 0) / earlier.length
        const trend = recentAvg - earlierAvg
        const trendLabel = trend < -0.3 ? 'Declining' : trend > 0.3 ? 'Improving' : 'Stable'
        const trendColor = trend < -0.3 ? 'text-red-600' : trend > 0.3 ? 'text-green-600' : 'text-zinc-600'
        const TrendIcon = trend < -0.3 ? TrendingDown : trend > 0.3 ? TrendingUp : Minus
        const negCount = sentimentValues.filter(v => v === -1).length
        const posCount = sentimentValues.filter(v => v === 1).length
        const neuCount = sentimentValues.filter(v => v === 0).length

        return (
          <SentimentSection
            trendLabel={trendLabel}
            trendColor={trendColor}
            TrendIcon={TrendIcon}
            trend={trend}
            posCount={posCount}
            neuCount={neuCount}
            negCount={negCount}
            total={sentimentValues.length}
            sentimentHistory={sentimentHistory}
          />
        )
      })()}

      {/* Customer History */}
      {customerHistory.length > 0 && (
        <SidebarSection title="Customer History" icon={History} defaultOpen={false}>
          <ul className="space-y-2">
            {customerHistory.map(item => (
              <li key={item.id}>
                <a
                  href={'/conversations/' + item.id}
                  className="flex items-start gap-2 rounded-lg p-2 hover:bg-muted cursor-pointer transition-colors no-underline"
                >
                  <MessageSquare size={13} className="mt-0.5 shrink-0 text-zinc-500" />
                  <div className="min-w-0">
                    <p className="text-xs text-zinc-700 truncate hover:text-teal-700 transition-colors">{item.preview}</p>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
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
