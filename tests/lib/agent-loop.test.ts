// Tests for src/lib/ai/agent.ts — the agent loop.
//
// The ones that matter most:
//   * every tool_call gets exactly one tool message back. Miss one and the next
//     request is a 400 (a dangling tool_call is a malformed transcript), which
//     would kill the run for a reason no operator could diagnose from the UI.
//   * a tool the run never offered can NEVER execute, whatever name the model
//     emits. The model reads customer text, so "emit a name you weren't given"
//     is reachable by prompt injection, not just by hallucination.
//   * a runaway model is bounded. maxSteps and the deadline both have to stop
//     the loop, and it must still return a usable answer + trace.
//
// The model is scripted: each test queues the exact turns callChat returns, so
// the loop is tested in isolation from any provider.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- Scripted model ------------------------------------------------

interface ScriptedTurn {
  content?: string
  tool_calls?: { id: string; name: string; args: string }[]
}

let script: ScriptedTurn[] = []
/** Every messages[] array handed to the model, in order. */
let sentTranscripts: any[][] = []
let callChatCalls = 0

vi.mock('@/lib/api-helpers', () => ({
  callChat: vi.fn(async (messages: any[]) => {
    callChatCalls++
    sentTranscripts.push(JSON.parse(JSON.stringify(messages)))
    const turn = script.shift() ?? { content: 'fallback answer' }
    return {
      content: turn.content ?? '',
      tool_calls: (turn.tool_calls ?? []).map((t) => ({
        id: t.id,
        type: 'function' as const,
        function: { name: t.name, arguments: t.args },
      })),
      finish_reason: turn.tool_calls?.length ? 'tool_calls' : 'stop',
      model: 'test-model',
      input_tokens: 10,
      output_tokens: 5,
    }
  }),
  verifyAccountAccess: vi.fn(async () => true),
}))

let canReturns = true
vi.mock('@/lib/permissions/server', () => ({
  userIdCan: vi.fn(async () => canReturns),
}))

vi.mock('@/lib/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(async () => {}),
}))
vi.mock('@/lib/metrics', () => ({ recordMetric: vi.fn() }))
vi.mock('@/lib/kb-retrieval', () => ({
  retrieveKbContext: vi.fn(async () => ({ enabled: true, chunks: [] })),
}))

import { runAgent } from '@/lib/ai/agent'
import type { AgentTool, ToolContext } from '@/lib/ai/tools'

// ---- Fixtures ------------------------------------------------------

const ctx: ToolContext = {
  userId: 'user-1',
  companyId: 'company-1',
  accountId: 'account-1',
  conversationId: 'conv-1',
  requestId: 'req-1',
  client: {} as any,
}

const readTool: AgentTool = {
  name: 'read_thing',
  description: 'Reads a thing',
  parameters: { type: 'object', properties: {}, required: [] },
  permission: null,
  mutates: false,
  handler: async () => ({ thing: 'value' }),
}

const gatedTool: AgentTool = {
  name: 'gated_thing',
  description: 'Needs permission',
  parameters: { type: 'object', properties: {}, required: [] },
  permission: 'action:message.send',
  mutates: false,
  handler: async () => ({ ok: true }),
}

const writeTool: AgentTool = {
  name: 'write_thing',
  description: 'Mutates',
  parameters: { type: 'object', properties: {}, required: [] },
  permission: null,
  mutates: true,
  handler: async () => ({ written: true }),
}

const explodingTool: AgentTool = {
  name: 'explodes',
  description: 'Always throws',
  parameters: { type: 'object', properties: {}, required: [] },
  permission: null,
  mutates: false,
  handler: async () => {
    throw new Error('upstream is down')
  },
}

function run(opts: Partial<Parameters<typeof runAgent>[0]> = {}) {
  return runAgent({
    systemPrompt: 'You are a test agent.',
    userMessage: 'do the thing',
    tools: [readTool],
    ctx,
    endpoint: 'agent-copilot',
    ...opts,
  })
}

beforeEach(() => {
  script = []
  sentTranscripts = []
  callChatCalls = 0
  canReturns = true
})

// ---- Tests ---------------------------------------------------------

describe('agent loop', () => {
  it('answers directly when the model calls no tools', async () => {
    script = [{ content: 'here is the answer' }]
    const res = await run()
    expect(res.answer).toBe('here is the answer')
    expect(res.tool_calls).toBe(0)
    expect(callChatCalls).toBe(1)
  })

  it('runs a tool, feeds the result back, and answers', async () => {
    script = [
      { tool_calls: [{ id: 'c1', name: 'read_thing', args: '{}' }] },
      { content: 'answer using the tool result' },
    ]
    const res = await run()
    expect(res.answer).toBe('answer using the tool result')
    expect(res.tool_calls).toBe(1)
    expect(res.stop_reason).toBe('answered')

    // The tool's output must actually reach the model.
    const second = sentTranscripts[1]
    const toolMsg = second.find((m: any) => m.role === 'tool')
    expect(toolMsg).toBeTruthy()
    expect(toolMsg.content).toContain('value')
  })

  it('returns exactly one tool message per tool_call, keyed by id', async () => {
    script = [
      {
        tool_calls: [
          { id: 'c1', name: 'read_thing', args: '{}' },
          { id: 'c2', name: 'read_thing', args: '{}' },
          { id: 'c3', name: 'nope_not_offered', args: '{}' },
        ],
      },
      { content: 'done' },
    ]
    await run()
    const second = sentTranscripts[1]
    const toolMsgs = second.filter((m: any) => m.role === 'tool')
    // Three calls -> three results, INCLUDING the one that failed.
    expect(toolMsgs).toHaveLength(3)
    expect(toolMsgs.map((m: any) => m.tool_call_id).sort()).toEqual(['c1', 'c2', 'c3'])
  })

  it('never executes a tool the run did not offer', async () => {
    const spy = vi.fn(async () => ({ written: true }))
    script = [
      { tool_calls: [{ id: 'c1', name: 'write_thing', args: '{}' }] },
      { content: 'done' },
    ]
    // write_thing exists as a tool object but is NOT in this run's tool list.
    await run({ tools: [readTool, { ...writeTool, handler: spy }].slice(0, 1) })
    expect(spy).not.toHaveBeenCalled()
    const toolMsg = sentTranscripts[1].find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('Unknown tool')
  })

  it('withholds mutating tools in read-only mode and refuses them if called', async () => {
    const spy = vi.fn(async () => ({ written: true }))
    script = [
      { tool_calls: [{ id: 'c1', name: 'write_thing', args: '{}' }] },
      { content: 'done' },
    ]
    await run({ tools: [{ ...writeTool, handler: spy }], readOnly: true })
    expect(spy).not.toHaveBeenCalled()
  })

  it('turns an RBAC denial into a tool result instead of throwing', async () => {
    canReturns = false
    script = [
      { tool_calls: [{ id: 'c1', name: 'gated_thing', args: '{}' }] },
      { content: 'carried on without it' },
    ]
    const res = await run({ tools: [gatedTool] })
    expect(res.answer).toBe('carried on without it')
    const toolMsg = sentTranscripts[1].find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('permission')
  })

  it('turns malformed tool arguments into a tool result instead of throwing', async () => {
    script = [
      { tool_calls: [{ id: 'c1', name: 'read_thing', args: '{not json' }] },
      { content: 'recovered' },
    ]
    const res = await run()
    expect(res.answer).toBe('recovered')
    const toolMsg = sentTranscripts[1].find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('valid JSON')
  })

  it('turns a throwing tool handler into a tool result instead of crashing the run', async () => {
    script = [
      { tool_calls: [{ id: 'c1', name: 'explodes', args: '{}' }] },
      { content: 'handled the failure' },
    ]
    const res = await run({ tools: [explodingTool] })
    expect(res.answer).toBe('handled the failure')
    const toolMsg = sentTranscripts[1].find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('upstream is down')
  })

  it('bounds a runaway model at maxSteps and still forces an answer', async () => {
    // A model that keeps calling a tool: it burns every one of the 3 allowed
    // steps without ever answering. The 4th turn is the forced one — it can
    // only be prose, because that call is made with no tools offered.
    script = [
      { tool_calls: [{ id: 'c1', name: 'read_thing', args: '{}' }] },
      { tool_calls: [{ id: 'c2', name: 'read_thing', args: '{}' }] },
      { tool_calls: [{ id: 'c3', name: 'read_thing', args: '{}' }] },
      { content: 'forced final answer' },
    ]

    const res = await run({ maxSteps: 3 })
    // 3 looped model calls + 1 forced final call.
    expect(res.model_calls).toBe(4)
    expect(res.tool_calls).toBe(3)
    expect(res.answer).toBe('forced final answer')

    // The forced call must offer NO tools, or it would just loop again.
    const lastCall = (await import('@/lib/api-helpers')).callChat as any
    const lastArgs = lastCall.mock.calls[lastCall.mock.calls.length - 1]
    expect(lastArgs[2]?.tools).toBeUndefined()
  })

  it('stops on the deadline without starting another model call', async () => {
    script = [{ content: 'never reached' }]
    const res = await run({ deadlineMs: -1 })
    expect(callChatCalls).toBe(0)
    expect(res.stop_reason).toBe('deadline')
  })

  it('flags a model that ignores tools entirely as no_tool_support', async () => {
    script = [{ content: 'I answered without using any tool' }]
    const res = await run()
    expect(res.stop_reason).toBe('no_tool_support')
  })

  it('records a step trace covering every model and tool step', async () => {
    script = [
      { tool_calls: [{ id: 'c1', name: 'read_thing', args: '{}' }] },
      { content: 'done' },
    ]
    const res = await run()
    expect(res.steps.map((s) => s.kind)).toEqual(['model', 'tool', 'model'])
    expect(res.steps[1].tool_name).toBe('read_thing')
    expect(res.steps[1].tool_ok).toBe(true)
    expect(res.steps.map((s) => s.index)).toEqual([1, 2, 3])
  })

  it('sums token usage across every step of the run', async () => {
    script = [
      { tool_calls: [{ id: 'c1', name: 'read_thing', args: '{}' }] },
      { content: 'done' },
    ]
    const res = await run()
    // 2 model calls x (10 in / 5 out)
    expect(res.input_tokens).toBe(20)
    expect(res.output_tokens).toBe(10)
  })
})
