import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { verifyAccountAccess, checkRateLimit } from '@/lib/api-helpers'
import { userIdCan } from '@/lib/permissions/server'
import { userCanAccessConversationChannel } from '@/lib/permissions/channel-access'
import { AIBudgetExceededError } from '@/lib/ai-usage'
import { CircuitBreakerOpenError } from '@/lib/ai-circuit-breaker'
import { logError } from '@/lib/logger'
import { getRequestId } from '@/lib/request-id'
import { runAgent } from '@/lib/ai/agent'
import { toolsFor } from '@/lib/ai/tools'
import { persistAgentRun } from '@/lib/ai/trace'

/**
 * The FIRST route in this codebase to declare maxDuration — everything else
 * inherits an invisible dashboard default (15s without Fluid Compute, 300s
 * with). That is fine for a single-shot call but not here: an agent run is
 * several model calls, each of which can take up to AI_TIMEOUT_MS (30s).
 *
 * 60s ceiling, and the loop is given a 45s deadline so it stops itself with
 * ~15s spare to persist the trace and respond. Raise them together or not at
 * all — a deadline at or above maxDuration means the function is killed
 * mid-run and the trace is lost, which is the one outcome worth avoiding.
 */
export const maxDuration = 60
// The loop must STOP starting model calls with enough headroom to finish an
// in-flight call (≤20s, no retries — see AGENT_CALL_TIMEOUT_MS) plus persist the
// trace, all inside maxDuration. 30s leaves ~30s of headroom: a call started at
// t≈30s ends by ≈50s, trace by ≈52s, comfortably under 60. (Was 45s, which with
// the old 30s×3-retry calls could run ~94s and get killed → 504.)
const AGENT_DEADLINE_MS = 30_000

export const dynamic = 'force-dynamic'

// Generous for a human typing questions, firm against a stuck client loop.
const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW_SECONDS = 60

/**
 * Written to be anti-hallucination first. The failure mode that destroys trust
 * in a support copilot is not "it didn't know" — it's "it confidently invented a
 * refund policy", which an agent then pastes to a customer. So the prompt makes
 * "I don't know, here's what's missing" an explicitly correct answer, and ties
 * every factual claim to a tool result.
 */
const SYSTEM_PROMPT = `You are a support copilot. You are talking TO a human support agent who is working a customer conversation — not to the customer. Never phrase your reply as if the customer will read it, unless you are explicitly asked to draft a reply.

Use your tools before answering. In particular:
- Call search_knowledge_base before answering anything about policy, pricing, entitlements, or how something works.
- Call get_conversation_thread before summarising, drafting, or judging what has happened.
- Call get_contact_history when asked about the customer, or when judging how urgent something is.

Hard rules:
- Ground every factual claim in something a tool returned. If you did not read it, do not claim it.
- If search_knowledge_base returns nothing relevant, say the knowledge base does not cover it. Do NOT fall back on general knowledge — a plausible invented policy is worse than "I don't know", because the agent may send it to the customer.
- Never invent order numbers, dates, prices, names, or policy details.
- If you cannot answer, say precisely what is missing.
- Be concise and skimmable. The agent is mid-conversation.`

/**
 * POST /api/ai/copilot
 *
 * Body: { conversation_id: string, message: string }
 * Returns: { answer, run_id, stop_reason, tool_calls, model_calls, duration_ms }
 *          or { skipped: true, reason } on budget/breaker, so the UI degrades
 *          softly instead of erroring (matches every other AI route here).
 *
 * READ-ONLY BY CONSTRUCTION: it runs with `toolsFor({ readOnly: true })`, so
 * mutating tools are never even offered to the model, and runTool refuses them
 * again if one is somehow named. This route cannot change a single row of the
 * user's data — which is what makes it safe to put in front of real traffic
 * first.
 */
export async function POST(request: Request) {
  const requestId = await getRequestId()

  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 })
  }

  // Same gate as the other compose-shaped AI features.
  if (!(await userIdCan(user.id, 'action:ai.compose'))) {
    return NextResponse.json(
      { error: 'AI is not enabled for your role', request_id: requestId },
      { status: 403 }
    )
  }

  let body: { conversation_id?: string; message?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', request_id: requestId }, { status: 400 })
  }

  const conversationId = body.conversation_id
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'conversation_id required', request_id: requestId }, { status: 400 })
  }
  if (!message) {
    return NextResponse.json({ error: 'message required', request_id: requestId }, { status: 400 })
  }
  if (message.length > 4000) {
    return NextResponse.json({ error: 'message too long', request_id: requestId }, { status: 400 })
  }

  const rateAllowed = await checkRateLimit(
    `ai-copilot:${user.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_SECONDS
  )
  if (!rateAllowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again shortly.', request_id: requestId },
      { status: 429 }
    )
  }

  const admin = await createServiceRoleClient()

  // Resolve the conversation -> account -> company. Every one of these is
  // server-resolved; none of it is ever taken from the model or the body
  // beyond the conversation id, which is access-checked immediately below.
  const { data: conversation, error: convError } = await admin
    .from('conversations')
    .select('id, account_id, channel, accounts!inner(company_id)')
    .eq('id', conversationId)
    .maybeSingle()

  if (convError || !conversation) {
    return NextResponse.json({ error: 'Conversation not found', request_id: requestId }, { status: 404 })
  }

  if (!(await verifyAccountAccess(user.id, conversation.account_id))) {
    return NextResponse.json({ error: 'Access denied to this conversation', request_id: requestId }, { status: 403 })
  }

  // The read path's RLS enforces per-channel visibility, but this route loaded
  // the conversation with a service-role client (RLS off), so re-check it here
  // — same reason the guarded mutation routes do.
  if (!(await userCanAccessConversationChannel(user.id, conversation.channel))) {
    return NextResponse.json({ error: 'Access denied to this channel', request_id: requestId }, { status: 403 })
  }

  const companyId =
    (conversation as unknown as { accounts?: { company_id?: string | null } }).accounts?.company_id ?? null

  try {
    const result = await runAgent({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: message,
      tools: toolsFor({ readOnly: true }),
      readOnly: true,
      endpoint: 'agent-copilot',
      deadlineMs: AGENT_DEADLINE_MS,
      ctx: {
        userId: user.id,
        companyId,
        accountId: conversation.account_id,
        conversationId: conversation.id,
        requestId,
        client: admin,
      },
    })

    // Fail-soft by contract: a null run_id means the trace didn't persist, and
    // the answer is still returned. Never let observability break the product.
    const runId = await persistAgentRun(admin, {
      result,
      accountId: conversation.account_id,
      conversationId: conversation.id,
      userId: user.id,
      endpoint: 'agent-copilot',
      requestId,
      input: message,
    })

    // Compact tool trace for the UI: the ordered names + whether each
    // succeeded. This is the "how it answered" surface — it lets an agent see
    // "searched the KB, found nothing, checked contact history" rather than
    // trusting an opaque answer. The full step-by-step trace (with arguments and
    // results) lives in agent_run_steps behind run_id for a deeper view later.
    const tool_summary = result.steps
      .filter((s) => s.kind === 'tool')
      .map((s) => ({ name: s.tool_name, ok: s.tool_ok !== false }))

    return NextResponse.json({
      answer: result.answer,
      run_id: runId,
      stop_reason: result.stop_reason,
      tool_calls: result.tool_calls,
      model_calls: result.model_calls,
      duration_ms: result.duration_ms,
      tool_summary,
      request_id: requestId,
    })
  } catch (err) {
    // Budget and breaker are expected operational states, not bugs — 200 +
    // skipped so the UI shows a soft state, exactly like the other AI routes.
    if (err instanceof AIBudgetExceededError) {
      return NextResponse.json({ skipped: true, reason: 'ai_budget_exceeded', request_id: requestId })
    }
    if (err instanceof CircuitBreakerOpenError) {
      return NextResponse.json({ skipped: true, reason: 'ai_unavailable', request_id: requestId })
    }
    const messageText = err instanceof Error ? err.message : 'Agent run failed'
    await logError('ai', 'copilot_run_failed', messageText, {
      request_id: requestId,
      user_id: user.id,
      conversation_id: conversationId,
    })
    return NextResponse.json({ error: 'Copilot failed', request_id: requestId }, { status: 500 })
  }
}
