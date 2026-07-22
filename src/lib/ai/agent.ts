/**
 * The agent loop: think → call tools → observe → repeat → answer.
 *
 * This is the whole of "agentic" in this codebase. Everything else — the
 * registry, the trace, the copilot route — hangs off it.
 *
 *   messages = [system, user]
 *   loop:
 *     turn = model(messages, tools)
 *     if turn has no tool calls  -> that prose IS the answer, stop
 *     else                       -> run each call, append results, go again
 *
 * It deliberately does NOT stream and does NOT run in the background. A run is
 * a handful of fast DB reads plus a few model calls, and it must finish inside
 * one serverless invocation — see DEADLINE below for why that is load-bearing.
 *
 * ── Why every run is bounded three ways ────────────────────────────────────
 *   maxSteps   a model that keeps calling tools forever is the classic agent
 *              failure. Each step costs money and latency, so the cap is the
 *              backstop that turns "runaway" into "gave up".
 *   deadline   the function is killed at Vercel's maxDuration with no warning.
 *              Stopping ourselves first means we return a partial answer AND a
 *              trace, instead of the caller seeing a 504 and us seeing nothing.
 *   budget     inherited free: every model call goes through callChat, which
 *              enforces the per-account monthly cap and records ai_usage.
 */

import {
  callChat,
  AIBudgetExceededError,
  CircuitBreakerOpenError,
  type ChatMessage,
  type ToolCall,
} from '@/lib/api-helpers'
import type { AIEndpoint } from '@/lib/ai-usage'
import { runTool, toToolSpecs, type AgentTool, type ToolContext } from '@/lib/ai/tools'
import { logInfo } from '@/lib/logger'
import { recordMetric } from '@/lib/metrics'

/** Model calls per run. 6 is generous: real runs settle in 2–4. */
export const DEFAULT_MAX_STEPS = 6

/**
 * Per-model-call timeout, with NO retries (see callChat below).
 *
 * An agent run makes several calls, so it must fail fast on a flaky provider: a
 * single call left on the default 30s × 3 retries (~94s observed on NVIDIA when
 * it hangs) blows past any maxDuration and becomes a 504. 20s is well above the
 * ~3s a healthy call takes, so it only bites when the provider is actually slow.
 */
export const AGENT_CALL_TIMEOUT_MS = 20_000

/**
 * Stop this long before the function's own ceiling.
 *
 * Vercel kills the invocation at maxDuration with no chance to flush. A single
 * model call can take up to AI_TIMEOUT_MS (30s), so the loop checks the clock
 * BEFORE starting another step and bails while it still has time to persist the
 * trace and answer. Callers should pass a deadline derived from the route's own
 * `maxDuration`, not guess.
 */
export const DEFAULT_DEADLINE_MS = 60_000

/** A tool result larger than this is truncated before going back to the model. */
const MAX_TOOL_RESULT_CHARS = 6_000

export type StopReason =
  | 'answered'
  | 'max_steps'
  | 'deadline'
  | 'no_tool_support'
  | 'error'

export interface AgentStep {
  /** 1-based, in execution order — this is the trace's spine. */
  index: number
  kind: 'model' | 'tool'
  /** kind='model': what it said / asked for. */
  content?: string
  tool_calls?: { name: string; arguments: string }[]
  /** kind='tool': what ran and what came back. */
  tool_name?: string
  tool_args?: string
  tool_ok?: boolean
  tool_result?: unknown
  tool_error?: string
  duration_ms: number
}

export interface AgentRunResult {
  /** The final prose answer. May be empty if the run hit a bound. */
  answer: string
  steps: AgentStep[]
  stop_reason: StopReason
  model: string
  model_calls: number
  tool_calls: number
  input_tokens: number
  output_tokens: number
  duration_ms: number
}

export interface RunAgentOptions {
  systemPrompt: string
  userMessage: string
  tools: AgentTool[]
  ctx: ToolContext
  endpoint: AIEndpoint
  maxSteps?: number
  deadlineMs?: number
  /** Withhold mutating tools entirely (the copilot). Enforced again in runTool. */
  readOnly?: boolean
  /**
   * Record mutating tool calls instead of applying them (the triage agent's
   * evaluation mode). Read-only tools still run — reading is what makes the
   * recorded decision realistic. The caller is responsible for persisting the
   * run with shadow=true so the trace reflects that nothing was applied.
   */
  shadow?: boolean
}

/**
 * Serialise a tool result for the model.
 *
 * Truncation matters: a KB search can return several thousand characters per
 * chunk, and an un-capped result both blows the context window and gets billed
 * on every subsequent step (the transcript is resent each time). Truncating is
 * announced in-band so the model knows it is seeing a prefix, not the whole.
 */
function serialiseToolResult(result: { ok: boolean; data: unknown; error?: string }): string {
  const payload = result.ok ? result.data : { error: result.error }
  let text: string
  try {
    text = JSON.stringify(payload)
  } catch {
    text = JSON.stringify({ error: 'Tool result could not be serialised' })
  }
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    text = text.slice(0, MAX_TOOL_RESULT_CHARS) + '…[truncated]'
  }
  return text
}

/**
 * Run one agent to completion (or to a bound).
 *
 * Returns rather than throws for every *expected* ending — including hitting the
 * step cap or the deadline — because a partial run with a trace is far more
 * useful to an operator than an exception. Genuine infrastructure failures
 * (budget exceeded, circuit open) still propagate, so routes keep their existing
 * graceful-skip handling.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const {
    systemPrompt,
    userMessage,
    tools,
    ctx,
    endpoint,
    maxSteps = DEFAULT_MAX_STEPS,
    deadlineMs = DEFAULT_DEADLINE_MS,
    readOnly = false,
    shadow = false,
  } = opts

  const startedAt = Date.now()
  const deadlineAt = startedAt + deadlineMs
  const toolSpecs = toToolSpecs(tools)

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ]

  const steps: AgentStep[] = []
  let answer = ''
  let stop_reason: StopReason = 'max_steps'
  let model = ''
  let model_calls = 0
  let tool_call_count = 0
  let input_tokens = 0
  let output_tokens = 0

  for (let step = 0; step < maxSteps; step++) {
    // Check the clock BEFORE a call that could take 30s, not after.
    if (Date.now() >= deadlineAt) {
      stop_reason = 'deadline'
      break
    }

    const modelStartedAt = Date.now()
    // Fail fast + no retries: on a flaky provider we want a clean partial, not a
    // 90s hang that the route's maxDuration turns into a 504. A throw here (the
    // provider timed out / errored) is caught and ends the run as 'error' with
    // whatever we already have, rather than crashing the whole request.
    let turn: Awaited<ReturnType<typeof callChat>>
    try {
      turn = await callChat(messages, { ...ctxToCallContext(ctx), endpoint }, {
        tools: toolSpecs,
        timeoutMs: AGENT_CALL_TIMEOUT_MS,
        maxRetries: 0,
      })
    } catch (err) {
      // Budget + breaker are expected operational states the route turns into a
      // graceful 200 "skipped" — let them propagate rather than masking them as
      // a generic error.
      if (err instanceof AIBudgetExceededError || err instanceof CircuitBreakerOpenError) throw err
      stop_reason = 'error'
      steps.push({
        index: steps.length + 1,
        kind: 'model',
        content: undefined,
        duration_ms: Date.now() - modelStartedAt,
      })
      logInfo('ai', 'agent_call_failed', 'Agent model call failed', {
        request_id: ctx.requestId,
        endpoint,
        step,
        error: err instanceof Error ? err.message : 'unknown',
      })
      break
    }
    model_calls++
    model = turn.model
    input_tokens += turn.input_tokens
    output_tokens += turn.output_tokens

    steps.push({
      index: steps.length + 1,
      kind: 'model',
      content: turn.content || undefined,
      tool_calls: turn.tool_calls.map((t) => ({
        name: t.function.name,
        arguments: t.function.arguments,
      })),
      duration_ms: Date.now() - modelStartedAt,
    })

    // No tool calls => the model is done reasoning and this is its answer.
    if (turn.tool_calls.length === 0) {
      answer = turn.content
      stop_reason = 'answered'
      break
    }

    // Record the assistant's tool-call turn verbatim. The protocol requires the
    // assistant message and its tool results to be adjacent and complete.
    messages.push({
      role: 'assistant',
      content: turn.content || null,
      tool_calls: turn.tool_calls,
    })

    // Run this turn's calls concurrently — they're independent reads and the
    // model asked for them together precisely because it doesn't need them
    // sequenced. Errors are values here, so nothing rejects.
    const results = await Promise.all(
      turn.tool_calls.map(async (call: ToolCall) => {
        const toolStartedAt = Date.now()
        // `allowed: tools` is the security boundary: only what this run offered
        // can run, no matter what name the model emits. `shadow` records mutating
        // calls instead of applying them.
        const result = await runTool(call.function.name, call.function.arguments, ctx, {
          allowed: tools,
          readOnly,
          shadow,
        })
        return { call, result, duration_ms: Date.now() - toolStartedAt }
      })
    )

    for (const { call, result, duration_ms } of results) {
      tool_call_count++
      steps.push({
        index: steps.length + 1,
        kind: 'tool',
        tool_name: call.function.name,
        tool_args: call.function.arguments,
        tool_ok: result.ok,
        tool_result: result.ok ? result.data : undefined,
        tool_error: result.ok ? undefined : result.error,
        duration_ms,
      })
      // EVERY tool_call id must get exactly one tool message back, even a
      // failed one. Skip one and the next request is a 400 — the protocol
      // treats a dangling tool_call as a malformed transcript.
      messages.push({
        role: 'tool',
        content: serialiseToolResult(result),
        tool_call_id: call.id,
      })
    }
  }

  // Ran out of steps mid-tool-use: ask once more with tools withheld so the run
  // still ends with a usable answer instead of nothing. Skipped when we stopped
  // on the deadline — there is by definition no time left for another call.
  if (stop_reason === 'max_steps' && Date.now() < deadlineAt) {
    try {
      const finalTurn = await callChat(
        [
          ...messages,
          {
            role: 'user',
            content:
              'Stop using tools now and answer with what you already have. If it is not ' +
              'enough to answer confidently, say exactly what is missing.',
          },
        ],
        { ...ctxToCallContext(ctx), endpoint },
        { timeoutMs: AGENT_CALL_TIMEOUT_MS, maxRetries: 0 }
      )
      model_calls++
      input_tokens += finalTurn.input_tokens
      output_tokens += finalTurn.output_tokens
      answer = finalTurn.content
      steps.push({
        index: steps.length + 1,
        kind: 'model',
        content: finalTurn.content || undefined,
        duration_ms: 0,
      })
    } catch (err) {
      if (err instanceof AIBudgetExceededError || err instanceof CircuitBreakerOpenError) throw err
      // Provider failed on the wrap-up call; end as 'error' with an empty answer
      // rather than throwing the whole run away.
      stop_reason = 'error'
    }
  }

  const duration_ms = Date.now() - startedAt

  // A model with no tool support answers step 1 in prose without ever calling a
  // tool. That is indistinguishable from a good one-shot answer, EXCEPT that no
  // tool was called despite tools being offered — worth surfacing, because it
  // usually means the configured model silently can't do this job.
  if (stop_reason === 'answered' && tool_call_count === 0 && tools.length > 0) {
    stop_reason = 'no_tool_support'
  }

  recordMetric('ai.agent.duration_ms', duration_ms, { endpoint, stop_reason }, ctx.requestId)
  recordMetric('ai.agent.tool_calls', tool_call_count, { endpoint }, ctx.requestId)
  recordMetric('ai.agent.model_calls', model_calls, { endpoint }, ctx.requestId)

  logInfo('ai', 'agent_run_complete', 'Agent run finished', {
    request_id: ctx.requestId,
    user_id: ctx.userId,
    endpoint,
    stop_reason,
    model,
    model_calls,
    tool_calls: tool_call_count,
    duration_ms,
  })

  return {
    answer,
    steps,
    stop_reason,
    model,
    model_calls,
    tool_calls: tool_call_count,
    input_tokens,
    output_tokens,
    duration_ms,
  }
}

/** Map the tool context onto the AI call context (budget + model routing). */
function ctxToCallContext(ctx: ToolContext) {
  return {
    account_id: ctx.accountId,
    user_id: ctx.userId,
    request_id: ctx.requestId,
  }
}
