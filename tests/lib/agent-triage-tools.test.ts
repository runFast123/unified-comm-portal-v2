// Tests for the mutating triage tools (set_priority, add_tags) and shadow mode
// in src/lib/ai/tools.ts.
//
// These are the first tools that WRITE, on a user's behalf, so the bar is the
// security bar:
//   * shadow mode must NEVER invoke a mutating handler — the guarantee is
//     structural (enforced in runTool), not a flag each handler remembers to
//     check, because "record what it would do, apply nothing" is the whole basis
//     of trusting it later.
//   * a triage tool must require action:conversation.triage — the split that
//     lets an agent organize the inbox without being able to message customers.
//   * a triage tool must re-verify account access before writing — the client is
//     service-role (RLS off), so that check is the only tenant boundary.
//   * every applied change is audited with via:'agent', which the override-rate
//     analysis needs to tell an agent's change from a human's.

import { describe, it, expect, beforeEach, vi } from 'vitest'

let accessAllowed = true
let canReturns = true

vi.mock('@/lib/api-helpers', () => ({ verifyAccountAccess: vi.fn(async () => accessAllowed) }))
vi.mock('@/lib/permissions/server', () => ({ userIdCan: vi.fn(async () => canReturns) }))
vi.mock('@/lib/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(async () => {}),
}))
vi.mock('@/lib/kb-retrieval', () => ({
  retrieveKbContext: vi.fn(async () => ({ enabled: true, chunks: [] })),
}))

import { runTool, toolsFor, getTool } from '@/lib/ai/tools'
import type { ToolContext } from '@/lib/ai/tools'

// ---- Mock client: captures writes + audits, serves one conversation row ----

interface Captured {
  updates: { table: string; patch: Record<string, unknown> }[]
  audits: Record<string, unknown>[]
}
let captured: Captured
let convRow: Record<string, unknown>

function client(): any {
  return {
    from(table: string) {
      if (table === 'audit_log') {
        return {
          insert: async (row: Record<string, unknown>) => {
            captured.audits.push(row)
            return { error: null }
          },
        }
      }
      let patch: Record<string, unknown> | null = null
      const b: any = {
        select: () => b,
        update: (p: Record<string, unknown>) => {
          patch = p
          return b
        },
        eq: () => b,
        neq: () => b,
        order: () => b,
        // Terminal for read queries (kb_articles / messages); empty result is
        // fine — these tests exercise triage writes, not retrieval.
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: convRow, error: null }),
        // Reached only when the chain is awaited directly, i.e. update().eq().
        then: (resolve: (v: { error: null }) => void) => {
          captured.updates.push({ table, patch: patch ?? {} })
          resolve({ error: null })
        },
      }
      return b
    },
  }
}

const ALL = toolsFor()

function ctx(): ToolContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    accountId: 'account-1',
    conversationId: 'conv-1',
    requestId: 'req-1',
    client: client(),
  }
}

beforeEach(() => {
  captured = { updates: [], audits: [] }
  convRow = { id: 'conv-1', account_id: 'account-1', priority: 'medium', tags: ['existing'] }
  accessAllowed = true
  canReturns = true
})

// ---- Shadow mode: the structural guarantee ----

describe('shadow mode never applies a mutating tool', () => {
  it('records set_priority instead of writing, and does not touch the DB', async () => {
    const res = await runTool('set_priority', JSON.stringify({ priority: 'urgent' }), ctx(), {
      allowed: ALL,
      shadow: true,
    })
    expect(res.ok).toBe(true)
    expect((res.data as any).recorded).toBe(true)
    expect((res.data as any).would_call).toBe('set_priority')
    // The whole point: no write, no audit.
    expect(captured.updates).toHaveLength(0)
    expect(captured.audits).toHaveLength(0)
  })

  it('records add_tags instead of writing', async () => {
    const res = await runTool('add_tags', JSON.stringify({ tags: ['vip'] }), ctx(), {
      allowed: ALL,
      shadow: true,
    })
    expect(res.ok).toBe(true)
    expect((res.data as any).recorded).toBe(true)
    expect(captured.updates).toHaveLength(0)
  })

  it('still runs READ-ONLY tools in shadow mode (reads make the decision real)', async () => {
    const res = await runTool('search_knowledge_base', JSON.stringify({ query: 'refund' }), ctx(), {
      allowed: ALL,
      shadow: true,
    })
    expect(res.ok).toBe(true)
    // Not a recorded stub — the real handler ran.
    expect((res.data as any).recorded).toBeUndefined()
  })

  it('still enforces RBAC before recording (shadow is not a bypass)', async () => {
    canReturns = false
    const res = await runTool('set_priority', JSON.stringify({ priority: 'high' }), ctx(), {
      allowed: ALL,
      shadow: true,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('permission')
  })
})

// ---- set_priority (live) ----

describe('set_priority', () => {
  it('writes the new priority and audits it with via:agent', async () => {
    const res = await runTool('set_priority', JSON.stringify({ priority: 'urgent' }), ctx(), {
      allowed: ALL,
    })
    expect(res.ok).toBe(true)
    expect(captured.updates).toEqual([{ table: 'conversations', patch: { priority: 'urgent' } }])
    expect(captured.audits).toHaveLength(1)
    expect(captured.audits[0].action).toBe('conversation.priority_changed')
    expect((captured.audits[0].details as any).via).toBe('agent')
    expect((captured.audits[0].details as any).to).toBe('urgent')
    expect(captured.audits[0].user_id).toBe('user-1')
  })

  it('rejects a priority outside the enum without writing', async () => {
    const res = await runTool('set_priority', JSON.stringify({ priority: 'banana' }), ctx(), {
      allowed: ALL,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('priority must be one of')
    expect(captured.updates).toHaveLength(0)
  })

  it('is a no-op (no write, no audit) when the priority is unchanged', async () => {
    convRow.priority = 'high'
    const res = await runTool('set_priority', JSON.stringify({ priority: 'high' }), ctx(), {
      allowed: ALL,
    })
    expect(res.ok).toBe(true)
    expect((res.data as any).unchanged).toBe(true)
    expect(captured.updates).toHaveLength(0)
    expect(captured.audits).toHaveLength(0)
  })

  it('requires action:conversation.triage', async () => {
    canReturns = false
    const res = await runTool('set_priority', JSON.stringify({ priority: 'high' }), ctx(), {
      allowed: ALL,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('permission')
    expect(captured.updates).toHaveLength(0)
  })

  it('refuses to write across a tenant boundary', async () => {
    accessAllowed = false // verifyAccountAccess says no
    const res = await runTool('set_priority', JSON.stringify({ priority: 'high' }), ctx(), {
      allowed: ALL,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not found')
    expect(captured.updates).toHaveLength(0)
  })

  it('carries the right RBAC key on the tool itself', () => {
    expect(getTool('set_priority')?.permission).toBe('action:conversation.triage')
    expect(getTool('set_priority')?.mutates).toBe(true)
  })
})

// ---- add_tags (live) ----

describe('add_tags', () => {
  it('merges new tags with existing, dedupes, and audits only what was added', async () => {
    convRow.tags = ['billing']
    const res = await runTool('add_tags', JSON.stringify({ tags: ['vip', 'billing', 'urgent'] }), ctx(), {
      allowed: ALL,
    })
    expect(res.ok).toBe(true)
    const patch = captured.updates[0].patch.tags as string[]
    expect(patch.sort()).toEqual(['billing', 'urgent', 'vip'])
    // Only the genuinely-new tags are recorded as added.
    expect((captured.audits[0].details as any).added.sort()).toEqual(['urgent', 'vip'])
  })

  it('is a no-op when every tag already exists', async () => {
    convRow.tags = ['vip', 'billing']
    const res = await runTool('add_tags', JSON.stringify({ tags: ['vip'] }), ctx(), { allowed: ALL })
    expect((res.data as any).unchanged).toBe(true)
    expect(captured.updates).toHaveLength(0)
  })

  it('handles a conversation that has no tags yet', async () => {
    convRow.tags = null
    const res = await runTool('add_tags', JSON.stringify({ tags: ['first'] }), ctx(), { allowed: ALL })
    expect(res.ok).toBe(true)
    expect(captured.updates[0].patch.tags).toEqual(['first'])
  })

  it('drops empties and caps the number of tags', async () => {
    convRow.tags = []
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`)
    const res = await runTool('add_tags', JSON.stringify({ tags: ['  ', '', ...many] }), ctx(), {
      allowed: ALL,
    })
    expect(res.ok).toBe(true)
    // Capped at 10; blanks removed.
    expect((captured.updates[0].patch.tags as string[]).length).toBe(10)
  })

  it('rejects an empty tag list without writing', async () => {
    const res = await runTool('add_tags', JSON.stringify({ tags: [] }), ctx(), { allowed: ALL })
    expect(res.ok).toBe(false)
    expect(captured.updates).toHaveLength(0)
  })

  it('requires action:conversation.triage', async () => {
    canReturns = false
    const res = await runTool('add_tags', JSON.stringify({ tags: ['x'] }), ctx(), { allowed: ALL })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('permission')
  })
})

// ---- Registry-level guarantees ----

describe('triage tools in the registry', () => {
  it('are offered to a normal (non-readOnly) run but withheld from a readOnly run', () => {
    const all = toolsFor().map((t) => t.name)
    const readOnly = toolsFor({ readOnly: true }).map((t) => t.name)
    expect(all).toContain('set_priority')
    expect(all).toContain('add_tags')
    expect(readOnly).not.toContain('set_priority')
    expect(readOnly).not.toContain('add_tags')
  })
})
