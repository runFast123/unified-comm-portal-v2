// Unit tests for `src/lib/macros.ts` — the macro apply core.
//
// Macros set status / tags / assignee / priority on a conversation and NEVER
// send a message. These tests exercise the pure helpers (normalize, merge) and
// the `applyMacro` flow against the in-memory mock Supabase client — including
// the security-critical case where a cross-tenant assignee is rejected.

import { describe, it, expect, vi } from 'vitest'

import { createMockSupabase, type MockCall } from '../helpers/mock-supabase'

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}))

import {
  applyMacro,
  normalizeMacroActions,
  mergeTags,
  resolveConversationCompanyId,
  MacroValidationError,
  VALID_PRIORITIES,
  type MacroRecord,
  type ConversationRecord,
} from '@/lib/macros'

function filterVal(filters: MockCall['filters'], col: string): unknown {
  return filters?.find((f) => f.col === col)?.value
}

const baseConversation: ConversationRecord = {
  id: 'conv-1',
  account_id: 'acct-1',
  status: 'active',
  secondary_status: null,
  priority: 'medium',
  tags: ['existing'],
  assigned_to: null,
}

function makeMacro(actions: MacroRecord['actions']): MacroRecord {
  return { id: 'macro-1', company_id: 'co-1', name: 'Test Macro', is_active: true, actions }
}

// ── normalizeMacroActions ───────────────────────────────────────────────────
describe('normalizeMacroActions', () => {
  it('returns {} for null / non-object / bad json', () => {
    expect(normalizeMacroActions(null)).toEqual({})
    expect(normalizeMacroActions(42)).toEqual({})
    expect(normalizeMacroActions([1, 2])).toEqual({})
    expect(normalizeMacroActions('not json')).toEqual({})
  })

  it('parses a JSON string payload', () => {
    expect(normalizeMacroActions('{"set_priority":"high"}')).toEqual({ set_priority: 'high' })
  })

  it('keeps known keys and drops empties / unknowns', () => {
    const out = normalizeMacroActions({
      set_status: '  awaiting_legal ',
      add_tags: ['vip', '  ', 7, 'urgent'],
      set_priority: 'high',
      reply_template_id: 'tmpl-1',
      bogus: 'nope',
    })
    expect(out).toEqual({
      set_status: 'awaiting_legal',
      add_tags: ['vip', 'urgent'],
      set_priority: 'high',
      reply_template_id: 'tmpl-1',
    })
  })

  it('distinguishes assign_to null (unassign) from absent', () => {
    expect(normalizeMacroActions({ assign_to: null })).toEqual({ assign_to: null })
    expect(normalizeMacroActions({ assign_to: 'user-9' })).toEqual({ assign_to: 'user-9' })
    expect('assign_to' in normalizeMacroActions({})).toBe(false)
  })
})

// ── mergeTags ───────────────────────────────────────────────────────────────
describe('mergeTags', () => {
  it('appends new tags and dedupes case-insensitively', () => {
    expect(mergeTags(['vip'], ['VIP', 'urgent'])).toEqual(['vip', 'urgent'])
  })
  it('handles null existing', () => {
    expect(mergeTags(null, ['a', 'b'])).toEqual(['a', 'b'])
  })
  it('preserves existing order', () => {
    expect(mergeTags(['b', 'a'], ['c'])).toEqual(['b', 'a', 'c'])
  })
})

// ── resolveConversationCompanyId ────────────────────────────────────────────
describe('resolveConversationCompanyId', () => {
  it('returns the account company_id', async () => {
    const mock = createMockSupabase({
      handlers: { accounts: { onSelect: () => ({ data: { company_id: 'co-1' }, error: null }) } },
    })
    await expect(resolveConversationCompanyId(mock.client as never, 'acct-1')).resolves.toBe('co-1')
  })
  it('returns null when the account is missing', async () => {
    const mock = createMockSupabase({
      handlers: { accounts: { onSelect: () => ({ data: null, error: null }) } },
    })
    await expect(resolveConversationCompanyId(mock.client as never, 'acct-x')).resolves.toBeNull()
  })
})

// ── applyMacro ──────────────────────────────────────────────────────────────
describe('applyMacro', () => {
  it('sets priority + tags and writes the conversation update', async () => {
    const mock = createMockSupabase()
    const result = await applyMacro(
      mock.client as never,
      makeMacro({ set_priority: 'high', add_tags: ['vip'] }),
      baseConversation,
      'co-1',
    )
    expect(result.applied).toContain('priority → high')
    expect(result.applied.some((a) => a.startsWith('tags +'))).toBe(true)
    const update = mock.updatesFor('conversations')[0] as Record<string, unknown>
    expect(update.priority).toBe('high')
    expect(update.tags).toEqual(['existing', 'vip'])
  })

  it('rejects an invalid priority (never writes)', async () => {
    const mock = createMockSupabase()
    await expect(
      applyMacro(mock.client as never, makeMacro({ set_priority: 'wat' }), baseConversation, 'co-1'),
    ).rejects.toBeInstanceOf(MacroValidationError)
    expect(mock.updatesFor('conversations')).toHaveLength(0)
  })

  it('validates set_status against the company catalog → written to secondary_status', async () => {
    const mock = createMockSupabase({
      handlers: {
        company_statuses: {
          onSelect: (f) => {
            // Scoped to the conversation's company.
            expect(filterVal(f, 'company_id')).toBe('co-1')
            return { data: { id: 's1', name: 'awaiting_legal' }, error: null }
          },
        },
      },
    })
    const result = await applyMacro(
      mock.client as never,
      makeMacro({ set_status: 'awaiting_legal' }),
      baseConversation,
      'co-1',
    )
    expect(result.applied).toContain('status → awaiting_legal')
    const update = mock.updatesFor('conversations')[0] as Record<string, unknown>
    expect(update.secondary_status).toBe('awaiting_legal')
  })

  it('rejects a status not in the company catalog', async () => {
    const mock = createMockSupabase({
      handlers: { company_statuses: { onSelect: () => ({ data: null, error: null }) } },
    })
    await expect(
      applyMacro(mock.client as never, makeMacro({ set_status: 'orphan' }), baseConversation, 'co-1'),
    ).rejects.toThrow(/not in this company/i)
  })

  it('assigns a same-company user', async () => {
    const mock = createMockSupabase({
      handlers: {
        users: {
          onSelect: () => ({
            data: { id: 'user-9', company_id: 'co-1', full_name: 'Aman', email: 'a@x.example' },
            error: null,
          }),
        },
      },
    })
    const result = await applyMacro(
      mock.client as never,
      makeMacro({ assign_to: 'user-9' }),
      baseConversation,
      'co-1',
    )
    expect(result.applied.some((a) => a.startsWith('assigned →'))).toBe(true)
    const update = mock.updatesFor('conversations')[0] as Record<string, unknown>
    expect(update.assigned_to).toBe('user-9')
  })

  it('REJECTS a cross-tenant assignee and never writes', async () => {
    const mock = createMockSupabase({
      handlers: {
        users: {
          // Assignee belongs to a DIFFERENT company than the conversation (co-1).
          onSelect: () => ({
            data: { id: 'user-evil', company_id: 'co-2', full_name: 'Mallory', email: 'm@x.example' },
            error: null,
          }),
        },
      },
    })
    await expect(
      applyMacro(mock.client as never, makeMacro({ assign_to: 'user-evil' }), baseConversation, 'co-1'),
    ).rejects.toThrow(/same company/i)
    expect(mock.updatesFor('conversations')).toHaveLength(0)
  })

  it('rejects assign to a missing user', async () => {
    const mock = createMockSupabase({
      handlers: { users: { onSelect: () => ({ data: null, error: null }) } },
    })
    await expect(
      applyMacro(mock.client as never, makeMacro({ assign_to: 'ghost' }), baseConversation, 'co-1'),
    ).rejects.toThrow(/not found/i)
  })

  it('unassigns when assign_to is null and the convo is currently assigned', async () => {
    const mock = createMockSupabase()
    const result = await applyMacro(
      mock.client as never,
      makeMacro({ assign_to: null }),
      { ...baseConversation, assigned_to: 'user-7' },
      'co-1',
    )
    expect(result.applied).toContain('unassigned')
    const update = mock.updatesFor('conversations')[0] as Record<string, unknown>
    expect(update.assigned_to).toBeNull()
  })

  it('surfaces reply_template_id via insertTemplateId but NEVER sends', async () => {
    const mock = createMockSupabase()
    const result = await applyMacro(
      mock.client as never,
      makeMacro({ reply_template_id: 'tmpl-42', set_priority: 'low' }),
      baseConversation,
      'co-1',
    )
    expect(result.insertTemplateId).toBe('tmpl-42')
    // No message / send table should ever be touched.
    const sendCalls = mock.calls.filter(
      (c) => c.table === 'messages' || c.table === 'pending_sends',
    )
    expect(sendCalls).toHaveLength(0)
  })

  it('is a no-op (empty applied, no update) when actions are empty', async () => {
    const mock = createMockSupabase()
    const result = await applyMacro(mock.client as never, makeMacro({}), baseConversation, 'co-1')
    expect(result.applied).toEqual([])
    expect(result.update).toEqual({})
    expect(mock.updatesFor('conversations')).toHaveLength(0)
  })

  it('does not re-write an already-current value', async () => {
    const mock = createMockSupabase()
    const result = await applyMacro(
      mock.client as never,
      makeMacro({ set_priority: 'medium' }), // conversation is already medium
      baseConversation,
      'co-1',
    )
    expect(result.applied).toEqual([])
    expect(mock.updatesFor('conversations')).toHaveLength(0)
  })

  it('VALID_PRIORITIES is the lifecycle enum set', () => {
    expect([...VALID_PRIORITIES]).toEqual(['low', 'medium', 'high', 'urgent'])
  })
})
