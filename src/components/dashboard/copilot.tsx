'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bot,
  Loader2,
  AlertTriangle,
  Send,
  Search,
  History,
  MessageSquare,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface CopilotProps {
  conversationId: string
}

interface ToolStep {
  name?: string
  ok: boolean
}

type Answer = {
  text: string
  toolSummary: ToolStep[]
  stopReason: string
  toolCalls: number
  durationMs: number
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'answer'; answer: Answer }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; message: string }

/** Human labels + icons for the tools, so the trace reads in plain language. */
const TOOL_META: Record<string, { label: string; icon: React.ElementType }> = {
  search_knowledge_base: { label: 'Searched the knowledge base', icon: Search },
  get_conversation_thread: { label: 'Read the conversation', icon: MessageSquare },
  get_contact_history: { label: "Checked the customer's history", icon: History },
}

const SUGGESTED = [
  'Summarize where this conversation stands',
  'Has this customer contacted us before?',
  'Draft a reply based on our knowledge base',
]

/**
 * A read-only support copilot. The agent answers questions about the
 * conversation using tools (KB search, thread, contact history) and never sends
 * anything — it drafts and informs; the human acts.
 *
 * The "How it answered" trace is deliberately front-and-centre. The way you
 * trust a non-deterministic assistant is by seeing what it actually did, not by
 * taking its word — so every answer shows which tools ran and whether they
 * found anything.
 */
export function Copilot({ conversationId }: CopilotProps) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [question, setQuestion] = useState('')
  const [showTrace, setShowTrace] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Reset when the agent navigates to another conversation, so an answer about
  // one thread never lingers over another.
  useEffect(() => {
    setState({ kind: 'idle' })
    setQuestion('')
    setShowTrace(false)
  }, [conversationId])

  const ask = useCallback(
    async (q: string) => {
      const trimmed = q.trim()
      if (!trimmed) return
      setState({ kind: 'loading' })
      setShowTrace(false)
      try {
        const res = await fetch('/api/ai/copilot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: conversationId, message: trimmed }),
        })
        const json = (await res.json().catch(() => null)) as
          | {
              answer?: string
              stop_reason?: string
              tool_calls?: number
              duration_ms?: number
              tool_summary?: ToolStep[]
              skipped?: boolean
              reason?: string
              error?: string
            }
          | null

        if (json?.skipped) {
          setState({ kind: 'skipped', reason: json.reason || 'unavailable' })
          return
        }
        if (!res.ok) {
          setState({ kind: 'error', message: json?.error || `Request failed (${res.status})` })
          return
        }
        setState({
          kind: 'answer',
          answer: {
            text: json?.answer || '',
            toolSummary: json?.tool_summary || [],
            stopReason: json?.stop_reason || 'answered',
            toolCalls: json?.tool_calls || 0,
            durationMs: json?.duration_ms || 0,
          },
        })
      } catch (err) {
        setState({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' })
      }
    },
    [conversationId]
  )

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void ask(question)
  }

  return (
    <div className="flex items-stretch overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Teal left accent bar — the "teal = AI" brand marker used across the sidebar. */}
      <span aria-hidden="true" className="w-1 shrink-0 bg-teal-600" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 px-4 py-3">
          <Bot size={16} className="text-teal-700" />
          <h3 className="flex-1 text-left text-sm font-semibold text-foreground">Copilot</h3>
          <span className="rounded-full bg-zinc-100 px-1.5 py-px text-[9px] font-medium uppercase tracking-wider text-zinc-500">
            read-only
          </span>
        </div>

        <div className="border-t border-border px-4 py-3">
          {/* Ask box — always present so a follow-up is one keystroke away. */}
          <form onSubmit={onSubmit} className="space-y-2">
            <label htmlFor="copilot-input" className="sr-only">
              Ask the copilot about this conversation
            </label>
            <div className="flex items-end gap-2">
              <textarea
                id="copilot-input"
                ref={inputRef}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  // Enter submits; Shift+Enter for a newline.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void ask(question)
                  }
                }}
                rows={2}
                placeholder="Ask about this conversation…"
                className="min-h-[40px] flex-1 resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
              />
              <button
                type="submit"
                disabled={state.kind === 'loading' || !question.trim()}
                aria-label="Ask copilot"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-600 text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {state.kind === 'loading' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
          </form>

          {/* Idle: suggested prompts, so the value is obvious without a blank box. */}
          {state.kind === 'idle' && (
            <div className="mt-3 space-y-1.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">Try asking</p>
              {SUGGESTED.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setQuestion(s)
                    void ask(s)
                  }}
                  className="block w-full rounded-lg bg-zinc-50 px-3 py-2 text-left text-xs text-zinc-600 ring-1 ring-zinc-200 transition-colors hover:bg-teal-50 hover:text-teal-800 hover:ring-teal-200"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {state.kind === 'loading' && (
            <div role="status" aria-live="polite" aria-label="Copilot is working" className="mt-3 space-y-2">
              <div className="flex items-center gap-2 text-xs text-teal-700">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Thinking, and checking sources…
              </div>
              <div className="space-y-1.5 rounded-xl bg-teal-50 p-3 ring-1 ring-teal-100">
                <div className="h-2.5 w-11/12 animate-pulse rounded bg-teal-200/70" />
                <div className="h-2.5 w-9/12 animate-pulse rounded bg-teal-200/70" />
                <div className="h-2.5 w-7/12 animate-pulse rounded bg-teal-200/70" />
              </div>
            </div>
          )}

          {state.kind === 'answer' && (
            <div className="mt-3 space-y-2">
              <div
                role="status"
                aria-live="polite"
                className="whitespace-pre-wrap rounded-xl bg-teal-50 p-3 text-sm leading-relaxed text-teal-900 ring-1 ring-teal-200"
              >
                {state.answer.text || 'No answer was produced.'}
              </div>

              {/* The stop reasons that are worth warning about. "answered" is the
                  happy path and needs no banner. */}
              {state.answer.stopReason === 'no_tool_support' && (
                <TraceNote tone="amber">
                  The model answered without using any tools — it may not support tool calling, so
                  this answer isn&apos;t grounded in your data. Check the configured model.
                </TraceNote>
              )}
              {(state.answer.stopReason === 'max_steps' || state.answer.stopReason === 'deadline') && (
                <TraceNote tone="amber">
                  The copilot ran out of {state.answer.stopReason === 'deadline' ? 'time' : 'steps'} before
                  finishing. This is a partial answer.
                </TraceNote>
              )}

              {/* How it answered — the trust surface. */}
              {state.answer.toolSummary.length > 0 ? (
                <div className="rounded-xl border border-border bg-white">
                  <button
                    type="button"
                    onClick={() => setShowTrace((v) => !v)}
                    aria-expanded={showTrace}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-medium text-zinc-500 hover:text-zinc-700"
                  >
                    <span className="flex-1">
                      How it answered · {state.answer.toolSummary.length} tool
                      {state.answer.toolSummary.length === 1 ? '' : 's'} used
                    </span>
                    {showTrace ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                  {showTrace && (
                    <ul className="space-y-1 border-t border-border px-3 py-2">
                      {state.answer.toolSummary.map((t, i) => {
                        const meta = t.name ? TOOL_META[t.name] : undefined
                        const Icon = meta?.icon ?? Search
                        return (
                          <li key={i} className="flex items-center gap-2 text-xs text-zinc-600">
                            <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                            <span className="flex-1">{meta?.label ?? t.name ?? 'tool'}</span>
                            {t.ok ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5 text-amber-600" />
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              ) : (
                <p className="px-1 text-[11px] text-zinc-400">Answered without using any tools.</p>
              )}

              <button
                type="button"
                onClick={() => {
                  setState({ kind: 'idle' })
                  inputRef.current?.focus()
                }}
                className="text-xs font-medium text-teal-700 hover:text-teal-800"
              >
                Ask another question
              </button>
            </div>
          )}

          {state.kind === 'skipped' && (
            <TraceNote tone="amber" className="mt-3">
              {state.reason === 'ai_budget_exceeded'
                ? "This account's AI budget is used up for the month. It resets next month."
                : 'The AI service is temporarily unavailable. Try again shortly.'}
            </TraceNote>
          )}

          {state.kind === 'error' && (
            <div className="mt-3 space-y-2">
              <TraceNote tone="amber">{state.message}</TraceNote>
              <button
                type="button"
                onClick={() => void ask(question)}
                className="text-xs font-medium text-teal-700 hover:text-teal-800"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TraceNote({
  tone,
  children,
  className,
}: {
  tone: 'amber'
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-xl p-2.5 text-[11px] ring-1',
        tone === 'amber' && 'bg-amber-50 text-amber-800 ring-amber-200',
        className
      )}
    >
      <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
      <span>{children}</span>
    </div>
  )
}
