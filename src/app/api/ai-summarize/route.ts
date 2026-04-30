import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { callAI, verifyAccountAccess } from '@/lib/api-helpers'
import { AIBudgetExceededError } from '@/lib/ai-usage'
import { logError } from '@/lib/logger'

const SYSTEM_PROMPT = `You are a customer support assistant. Summarize this conversation in 2-3 short sentences.
Focus on: what the customer needs, any action already taken, and the current status (waiting / resolved / blocked).
Be concrete. No filler phrases.`

/**
 * POST /api/ai-summarize
 *
 * Body: { conversation_id: string, force?: boolean }
 *
 * Returns: { summary: string|null, cached?: boolean, generated_at?: string,
 *           message_count?: number, skipped?: boolean, error?: string }
 *
 * Behavior:
 *   - Caches the summary on `conversations.ai_summary` so reloads don't burn
 *     AI tokens. Cache is keyed on message count: when the live message count
 *     exceeds `ai_summary_message_count`, the cache is treated as stale.
 *   - `force: true` always regenerates (used by the "Regenerate" button).
 *   - On `AIBudgetExceededError`, returns 200 with `skipped: true` so the UI
 *     can render a soft state instead of erroring.
 */
export async function POST(request: Request) {
  // Session auth
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { conversation_id?: string; force?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const conversationId = body.conversation_id
  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'conversation_id required' }, { status: 400 })
  }
  const force = body.force === true

  const admin = await createServiceRoleClient()

  // Look up conversation (with cached summary fields) to know its account,
  // then enforce scoping for non-admins.
  const { data: conversation, error: convError } = await admin
    .from('conversations')
    .select('id, account_id, ai_summary, ai_summary_generated_at, ai_summary_message_count')
    .eq('id', conversationId)
    .maybeSingle()

  if (convError || !conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  // verifyAccountAccess returns true for admins unconditionally, and for
  // non-admins only when the account belongs to their company.
  const hasAccess = await verifyAccountAccess(user.id, conversation.account_id)
  if (!hasAccess) {
    return NextResponse.json({ error: 'Access denied to this conversation' }, { status: 403 })
  }

  // Live message count for cache validity check.
  const { count: liveCount, error: countError } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)

  if (countError) {
    return NextResponse.json({ error: 'Failed to load messages' }, { status: 500 })
  }

  const currentMessageCount = liveCount ?? 0

  // ── Cache hit path ────────────────────────────────────────────────
  // Return the cached summary when:
  //   * not force-regenerating,
  //   * we have a stored summary,
  //   * AND the live message count hasn't grown past the cached count.
  if (
    !force &&
    conversation.ai_summary &&
    typeof conversation.ai_summary_message_count === 'number' &&
    currentMessageCount <= conversation.ai_summary_message_count
  ) {
    return NextResponse.json({
      summary: conversation.ai_summary,
      cached: true,
      generated_at: conversation.ai_summary_generated_at,
      message_count: conversation.ai_summary_message_count,
    })
  }

  if (currentMessageCount < 2) {
    return NextResponse.json(
      { error: 'Need at least 2 messages to summarize' },
      { status: 400 }
    )
  }

  // Fetch last 30 messages in timestamp order
  const { data: messages, error: msgError } = await admin
    .from('messages')
    .select('sender_name, direction, message_text, timestamp')
    .eq('conversation_id', conversationId)
    .order('timestamp', { ascending: false })
    .limit(30)

  if (msgError) {
    return NextResponse.json({ error: 'Failed to load messages' }, { status: 500 })
  }

  if (!messages || messages.length < 2) {
    return NextResponse.json(
      { error: 'Need at least 2 messages to summarize' },
      { status: 400 }
    )
  }

  // Oldest-first for the prompt
  const ordered = [...messages].reverse()
  const transcript = ordered
    .map((m) => {
      const name = (m.sender_name || '').toString().trim() || 'Unknown'
      const dir = m.direction === 'outbound' ? 'agent' : 'customer'
      const text = (m.message_text || '').toString().replace(/\s+/g, ' ').trim().slice(0, 600)
      return `[${name} (${dir})]: ${text}`
    })
    .join('\n')

  const userMessage = `Conversation:\n${transcript}`

  try {
    // callAI handles both `assertWithinBudget` (pre-call) AND `recordAIUsage`
    // (post-call) when an account_id is supplied — see src/lib/api-helpers.ts.
    const summary = await callAI(SYSTEM_PROMPT, userMessage, {
      account_id: conversation.account_id,
      endpoint: 'ai-summarize',
    })
    const cleaned = (summary || '').trim()
    if (!cleaned) {
      return NextResponse.json({ summary: null, error: 'Empty summary' }, { status: 200 })
    }

    // ── Persist to cache (best effort) ──────────────────────────────
    const generatedAt = new Date().toISOString()
    try {
      await admin
        .from('conversations')
        .update({
          ai_summary: cleaned,
          ai_summary_generated_at: generatedAt,
          ai_summary_message_count: currentMessageCount,
        })
        .eq('id', conversationId)
    } catch (cacheErr) {
      // Persistence failure shouldn't break the response — the user still
      // gets their summary, just no cache benefit on next load.
      logError(
        'ai',
        'summary_cache_write_failed',
        cacheErr instanceof Error ? cacheErr.message : 'unknown',
        { conversation_id: conversationId }
      )
    }

    return NextResponse.json({
      summary: cleaned,
      cached: false,
      generated_at: generatedAt,
      message_count: currentMessageCount,
    })
  } catch (err) {
    if (err instanceof AIBudgetExceededError) {
      logError('ai', 'budget_exceeded_summarize', err.message, {
        account_id: conversation.account_id,
        conversation_id: conversationId,
        monthly_total_usd: err.monthly_total_usd,
        budget_usd: err.budget_usd,
      })
      // Graceful 200 — the UI surfaces this as a soft skip, not an error.
      // If we still have a previously-cached summary, return it so the user
      // sees something useful.
      return NextResponse.json(
        {
          summary: conversation.ai_summary ?? null,
          cached: !!conversation.ai_summary,
          generated_at: conversation.ai_summary_generated_at,
          message_count: conversation.ai_summary_message_count,
          error: 'AI budget exceeded for this account',
          skipped: true,
          monthly_total_usd: err.monthly_total_usd,
          budget_usd: err.budget_usd,
          retry_after: 'next month',
        },
        { status: 200 }
      )
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isTimeout = /abort|timeout/i.test(message)
    logError('ai', 'summarize_failed', message, { conversation_id: conversationId })
    // Graceful fallback — 200 so the UI can render a soft error
    return NextResponse.json(
      {
        summary: null,
        error: isTimeout ? 'AI timed out' : 'AI call failed',
      },
      { status: 200 }
    )
  }
}
