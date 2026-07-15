// Tests for src/lib/ai/trace.ts — agent run trace persistence.
//
// The contract under test is a negative one: the trace must NEVER break the
// answer. A trace is an operational record, not product output — so a missing
// table, a transient DB error, or an unserialisable payload has to degrade to
// "no trace this time" and nothing worse. Every test here is really asking
// "does the user still get their answer when persistence goes wrong?"

import { describe, it, expect, beforeEach, vi } from 'vitest'

const logErrorSpy = vi.fn(async () => {})
vi.mock('@/lib/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: (...args: unknown[]) => logErrorSpy(...(args as [])),
}))

import { persistAgentRun } from '@/lib/ai/trace'
import type { AgentRunResult } from '@/lib/ai/agent'

// ---- Mock client ---------------------------------------------------

interface Captured {
  runs: any[]
  steps: any[][]
}
let captured: Captured
let failRunInsert = false
let failStepInsert = false
let throwOnFrom = false

function mockClient() {
  return {
    from(table: string) {
      if (throwOnFrom) throw new Error('client exploded')
      if (table === 'agent_runs') {
        return {
          insert(row: any) {
            captured.runs.push(row)
            return {
              select: () => ({
                single: async () =>
                  failRunInsert
                    ? { data: null, error: { message: 'relation does not exist' } }
                    : { data: { id: 'run-1' }, error: null },
              }),
            }
          },
        }
      }
      return {
        insert: async (rows: any[]) => {
          captured.steps.push(rows)
          return failStepInsert ? { error: { message: 'step insert failed' } } : { error: null }
        },
      }
    },
  } as any
}

function result(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    answer: 'the answer',
    steps: [
      { index: 1, kind: 'model', content: 'thinking', duration_ms: 10 },
      {
        index: 2,
        kind: 'tool',
        tool_name: 'search_knowledge_base',
        tool_args: '{"query":"refunds"}',
        tool_ok: true,
        tool_result: { matches: [] },
        duration_ms: 5,
      },
    ],
    stop_reason: 'answered',
    model: 'test-model',
    model_calls: 2,
    tool_calls: 1,
    input_tokens: 100,
    output_tokens: 50,
    duration_ms: 500,
    ...overrides,
  }
}

const base = {
  accountId: 'acc-1',
  conversationId: 'conv-1',
  userId: 'user-1',
  endpoint: 'agent-copilot' as const,
  requestId: 'req-1',
  input: 'what is the refund policy?',
}

beforeEach(() => {
  captured = { runs: [], steps: [] }
  failRunInsert = false
  failStepInsert = false
  throwOnFrom = false
  logErrorSpy.mockClear()
})

// ---- Tests ---------------------------------------------------------

describe('agent trace persistence', () => {
  it('writes the run and one row per step, in order', async () => {
    const id = await persistAgentRun(mockClient(), { result: result(), ...base })
    expect(id).toBe('run-1')
    expect(captured.runs).toHaveLength(1)
    expect(captured.runs[0]).toMatchObject({
      account_id: 'acc-1',
      conversation_id: 'conv-1',
      user_id: 'user-1',
      endpoint: 'agent-copilot',
      stop_reason: 'answered',
      model_calls: 2,
      tool_calls: 1,
      shadow: false,
    })
    expect(captured.steps[0]).toHaveLength(2)
    expect(captured.steps[0].map((s: any) => s.idx)).toEqual([1, 2])
    expect(captured.steps[0][1]).toMatchObject({
      kind: 'tool',
      tool_name: 'search_knowledge_base',
      tool_ok: true,
    })
  })

  it('parses tool arguments into jsonb rather than storing the raw string', async () => {
    await persistAgentRun(mockClient(), { result: result(), ...base })
    expect(captured.steps[0][1].tool_args).toEqual({ query: 'refunds' })
  })

  it('keeps unparseable tool arguments verbatim instead of dropping the step', async () => {
    const r = result()
    r.steps[1].tool_args = '{broken json'
    await persistAgentRun(mockClient(), { result: r, ...base })
    // A run that failed BECAUSE the model emitted broken arguments is exactly
    // when you most want to see what it emitted.
    expect(captured.steps[0][1].tool_args).toEqual({ unparsed: '{broken json' })
  })

  it('records shadow runs as shadow', async () => {
    await persistAgentRun(mockClient(), { result: result(), ...base, shadow: true })
    expect(captured.runs[0].shadow).toBe(true)
  })

  it('returns null (never throws) when the run insert fails', async () => {
    failRunInsert = true
    const id = await persistAgentRun(mockClient(), { result: result(), ...base })
    expect(id).toBeNull()
    expect(logErrorSpy).toHaveBeenCalled()
  })

  it('still returns the run id when only the step insert fails', async () => {
    // A trace with counts but no steps is degraded, not useless.
    failStepInsert = true
    const id = await persistAgentRun(mockClient(), { result: result(), ...base })
    expect(id).toBe('run-1')
    expect(logErrorSpy).toHaveBeenCalled()
  })

  it('swallows an unexpected client throw', async () => {
    throwOnFrom = true
    const id = await persistAgentRun(mockClient(), { result: result(), ...base })
    expect(id).toBeNull()
  })

  it('clamps oversized text instead of writing unbounded rows', async () => {
    const huge = 'x'.repeat(80_000)
    await persistAgentRun(mockClient(), { result: result({ answer: huge }), ...base, input: huge })
    expect(captured.runs[0].answer.length).toBeLessThan(21_000)
    expect(captured.runs[0].input.length).toBeLessThan(21_000)
    expect(captured.runs[0].answer).toContain('truncated')
  })

  it('replaces an oversized tool result with a valid preview object', async () => {
    const r = result()
    r.steps[1].tool_result = { blob: 'y'.repeat(40_000) }
    await persistAgentRun(mockClient(), { result: r, ...base })
    const stored = captured.steps[0][1].tool_result
    // Must remain valid JSON for a jsonb column — a hand-sliced string would be
    // rejected and lose the step entirely.
    expect(stored.truncated).toBe(true)
    expect(typeof stored.preview).toBe('string')
    expect(() => JSON.stringify(stored)).not.toThrow()
  })

  it('survives an unserialisable tool result', async () => {
    const circular: any = { a: 1 }
    circular.self = circular
    const r = result()
    r.steps[1].tool_result = circular
    const id = await persistAgentRun(mockClient(), { result: r, ...base })
    expect(id).toBe('run-1')
    expect(captured.steps[0][1].tool_result).toEqual({ unserialisable: true })
  })

  it('handles a run with no steps', async () => {
    const id = await persistAgentRun(mockClient(), { result: result({ steps: [] }), ...base })
    expect(id).toBe('run-1')
    expect(captured.steps).toHaveLength(0)
  })
})
