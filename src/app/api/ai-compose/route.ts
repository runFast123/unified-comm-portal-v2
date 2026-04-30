import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { callAI, verifyAccountAccess, checkRateLimit } from '@/lib/api-helpers'
import { AIBudgetExceededError } from '@/lib/ai-usage'
import { logError } from '@/lib/logger'

const SYSTEM_PROMPT =
  "Continue the user's message naturally. Output ONLY the continuation text — no preamble, no quotes, no explanations. Stay under 30 words. Match the tone of the conversation."

// Per-user cap: 30 requests / minute. UI silently stops requesting on 429.
const RATE_LIMIT_MAX = 30
const RATE_LIMIT_WINDOW_SECONDS = 60

const MAX_INPUT_LEN = 2000

/**
 * POST /api/ai-compose
 *
 * Body: { conversation_id: string, current_text: string }
 *
 * Returns: { suggestion: string, skipped?: boolean }
 *
 * Behavior:
 *   - Auth required; user must have access to the conversation's account.
 *   - Per-user rate limit (30/min) — returns 429 when exceeded so the UI
 *     can silently back off until the window resets.
 *   - On AIBudgetExceededError, returns a graceful 200 with
 *     `{ suggestion: null, skipped: true }` — never 500.
 *   - Pulls the last 5 messages of the conversation as context, then asks
 *     the model for a short continuation of `current_text`.
 *   - Cheap: max_tokens is bounded inside callAI by the AI config; the
 *     prompt itself caps the model to ~30 words.
 */
export async function POST(request: Request) {
  // ── Auth ────────────────────────────────────────────────────────────
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Per-user rate limit ────────────────────────────────────────────
  // Smart Compose fires on every typing pause, so a chatty agent could
  // easily run away with token spend. 30/min is generous for human
  // typing (≈ one suggestion every 2s) but firmly stops a stuck loop.
  const rateAllowed = await checkRateLimit(
    `ai-compose:${user.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_SECONDS
  )
  if (!rateAllowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', suggestion: '', skipped: true },
      { status: 429 }
    )
  }

  // ── Body parse ──────────────────────────────────────────────────────
  let body: { conversation_id?: string; current_text?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const conversationId = body.conversation_id
  const currentText = (body.current_text ?? '').toString()
  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'conversation_id required' }, { status: 400 })
  }
  if (currentText.length === 0) {
    return NextResponse.json({ suggestion: '' }, { status: 200 })
  }
  // Defensive cap — a runaway draft shouldn't burn tokens.
  const trimmedCurrent = currentText.slice(-MAX_INPUT_LEN)

  // ── Conversation lookup + access check ─────────────────────────────
  const admin = await createServiceRoleClient()
  const { data: conversation, error: convError } = await admin
    .from('conversations')
    .select('id, account_id')
    .eq('id', conversationId)
    .maybeSingle()

  if (convError || !conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const hasAccess = await verifyAccountAccess(user.id, conversation.account_id)
  if (!hasAccess) {
    return NextResponse.json({ error: 'Access denied to this conversation' }, { status: 403 })
  }

  // ── Build context from the last 5 messages ─────────────────────────
  // Newest 5, then reversed to chronological order for the prompt.
  const { data: messages, error: msgError } = await admin
    .from('messages')
    .select('sender_name, direction, message_text')
    .eq('conversation_id', conversationId)
    .order('timestamp', { ascending: false })
    .limit(5)

  if (msgError) {
    return NextResponse.json({ error: 'Failed to load context' }, { status: 500 })
  }

  const ordered = (messages ?? []).slice().reverse()
  const transcript = ordered
    .map((m) => {
      const name = (m.sender_name || '').toString().trim() || 'Unknown'
      const dir = m.direction === 'outbound' ? 'agent' : 'customer'
      const text = (m.message_text || '')
        .toString()
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400)
      return `[${name} (${dir})]: ${text}`
    })
    .join('\n')

  const userMessage =
    `Conversation context (most recent first at bottom):\n${transcript || '(no prior messages)'}\n\n` +
    `Agent is typing this reply — continue it naturally:\n"${trimmedCurrent}"`

  // ── AI call (with budget gate + usage recording inside callAI) ─────
  try {
    const raw = await callAI(SYSTEM_PROMPT, userMessage, {
      account_id: conversation.account_id,
      endpoint: 'ai-compose',
    })
    const cleaned = sanitizeContinuation(raw, trimmedCurrent)
    return NextResponse.json({ suggestion: cleaned }, { status: 200 })
  } catch (err) {
    if (err instanceof AIBudgetExceededError) {
      // Graceful skip — the UI never shows ghost text and stops asking.
      return NextResponse.json(
        { suggestion: null, skipped: true, error: 'AI budget exceeded for this account' },
        { status: 200 }
      )
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    logError('ai', 'compose_failed', message, {
      conversation_id: conversationId,
      account_id: conversation.account_id,
    })
    // Soft-fail — UI just shows no suggestion this time.
    return NextResponse.json({ suggestion: '' }, { status: 200 })
  }
}

/**
 * Strip preamble/explanations the model occasionally adds despite the prompt.
 * Also remove a leading copy of the user's typed text if the model echoed it.
 *
 * Returns '' when nothing usable remains so the UI shows no ghost text.
 */
function sanitizeContinuation(raw: string, currentText: string): string {
  if (!raw) return ''
  let s = raw.trim()
  // Strip surrounding quotes a model sometimes adds.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('“') && s.endsWith('”'))) {
    s = s.slice(1, -1).trim()
  }
  // Drop a leading "Continuation:" / "Reply:" preamble.
  s = s.replace(/^(continuation|reply|here(?:'s| is) (?:a|the) continuation)\s*[:\-]\s*/i, '')

  // If the model echoed the user's typed text, strip it.
  if (currentText && s.toLowerCase().startsWith(currentText.toLowerCase())) {
    s = s.slice(currentText.length)
  }

  // Collapse whitespace but preserve a single leading space if the
  // continuation needs to flow after the typed text.
  s = s.replace(/\s+/g, ' ').trim()

  // If the model returned just punctuation noise, drop it.
  if (!/[a-z0-9]/i.test(s)) return ''

  // If the user's text doesn't end in whitespace AND the suggestion doesn't
  // begin with whitespace or punctuation, prepend a single space so the
  // ghost text reads naturally when concatenated.
  if (
    currentText.length > 0 &&
    !/\s$/.test(currentText) &&
    !/^[\s.,;:!?)\]]/.test(s)
  ) {
    s = ' ' + s
  }
  return s
}
