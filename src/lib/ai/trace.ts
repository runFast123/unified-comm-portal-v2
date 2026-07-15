/**
 * Persistence for agent run traces (agent_runs + agent_run_steps).
 *
 * CONTRACT: never throws, never blocks the answer.
 *
 * A trace is an operational record, not part of the product's output. If the
 * insert fails — table missing because the migration hasn't been applied,
 * transient DB error, anything — the user must still get their answer. So every
 * failure here is swallowed and logged, exactly like logger.ts and metrics.ts.
 * `persistAgentRun` returns the run id on success and null otherwise; callers
 * treat null as "no trace this time", never as an error.
 *
 * The inverse also holds: the trace must never *change* what the agent did. It
 * is written after the run completes, from the returned result.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logError } from '@/lib/logger'
import type { AIEndpoint } from '@/lib/ai-usage'
import type { AgentRunResult } from '@/lib/ai/agent'

/**
 * Size caps. Steps hold whole tool payloads — a KB search can return several
 * thousand characters per chunk — and a trace is written on every single run.
 * Unbounded, this table would outgrow `messages`. These limits keep a trace
 * readable (which is its only job) without keeping it complete.
 */
const MAX_TEXT = 20_000
const MAX_JSON_CHARS = 8_000

function clampText(v: string | null | undefined): string | null {
  if (v == null) return null
  return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + '…[truncated]' : v
}

/**
 * Clamp a value destined for a jsonb column.
 *
 * Returns a `{ truncated, preview }` object rather than invalid JSON when the
 * payload is too big — a jsonb column will reject a hand-sliced string, and a
 * failed insert would lose the whole step.
 */
function clampJson(v: unknown): unknown {
  if (v === undefined) return null
  let text: string
  try {
    text = JSON.stringify(v)
  } catch {
    return { unserialisable: true }
  }
  if (text.length <= MAX_JSON_CHARS) return v
  return { truncated: true, preview: text.slice(0, MAX_JSON_CHARS) }
}

/** Tool arguments arrive as a JSON *string* from the model — may not parse. */
function parseArgs(raw: string | undefined): unknown {
  if (!raw) return null
  try {
    return clampJson(JSON.parse(raw))
  } catch {
    // Keep the raw text: a run that failed *because* the model emitted broken
    // arguments is exactly when you most want to see what it actually emitted.
    return { unparsed: raw.slice(0, 1000) }
  }
}

export interface PersistAgentRunParams {
  result: AgentRunResult
  accountId: string
  conversationId?: string | null
  userId: string
  endpoint: AIEndpoint
  requestId: string
  input: string
  /** True when the run's decisions were recorded but deliberately not applied. */
  shadow?: boolean
}

/**
 * Write one run and its steps. Returns the run id, or null if anything failed.
 */
export async function persistAgentRun(
  client: SupabaseClient,
  params: PersistAgentRunParams
): Promise<string | null> {
  const { result, accountId, conversationId, userId, endpoint, requestId, input, shadow } = params

  try {
    const { data: run, error: runErr } = await client
      .from('agent_runs')
      .insert({
        account_id: accountId,
        conversation_id: conversationId ?? null,
        user_id: userId,
        endpoint,
        request_id: requestId,
        input: clampText(input) ?? '',
        answer: clampText(result.answer),
        stop_reason: result.stop_reason,
        model: result.model || null,
        model_calls: result.model_calls,
        tool_calls: result.tool_calls,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        duration_ms: result.duration_ms,
        shadow: shadow ?? false,
      })
      .select('id')
      .single()

    if (runErr || !run) {
      await logError('ai', 'agent_trace_run_insert_failed', runErr?.message ?? 'no row returned', {
        request_id: requestId,
        user_id: userId,
        endpoint,
      })
      return null
    }

    if (result.steps.length > 0) {
      const rows = result.steps.map((s) => ({
        run_id: run.id,
        idx: s.index,
        kind: s.kind,
        content: clampText(s.content),
        tool_name: s.tool_name ?? null,
        tool_args: s.kind === 'tool' ? parseArgs(s.tool_args) : null,
        tool_result: s.kind === 'tool' ? clampJson(s.tool_result) : null,
        tool_ok: s.tool_ok ?? null,
        tool_error: clampText(s.tool_error),
        duration_ms: s.duration_ms,
      }))

      const { error: stepErr } = await client.from('agent_run_steps').insert(rows)
      if (stepErr) {
        // The run row survives on its own — a trace with counts but no steps is
        // degraded, not useless, so this is logged rather than rolled back.
        await logError('ai', 'agent_trace_steps_insert_failed', stepErr.message, {
          request_id: requestId,
          run_id: run.id,
          steps: rows.length,
        })
      }
    }

    return run.id as string
  } catch (err) {
    await logError(
      'ai',
      'agent_trace_unexpected_error',
      err instanceof Error ? err.message : 'unknown',
      { request_id: requestId, user_id: userId, endpoint }
    )
    return null
  }
}
