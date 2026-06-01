// Lightweight Supabase mock for integration tests.
//
// Builds chainable proxies that mimic the postgrest builder enough to support
// the patterns our route handlers actually use:
//   .from(table).select().eq().eq().in().limit().maybeSingle()
//   .from(table).select().eq().like().gte().limit().maybeSingle()
//   .from(table).insert(rows).select().single()
//   .from(table).update(values).eq()         (awaited directly via .then)
//   .from(table).update(values).eq().eq().eq()  (multi-eq update)
//
// Tests configure per-table behaviour by seeding rows AND/OR registering
// custom handlers for finer control. Every operation lands in `calls` so
// assertions like "messages.insert was called with reply_required:false"
// can be made directly.
//
// Intentionally NOT a full postgrest stub. Add chain methods only when a
// test actually needs them.

import { vi } from 'vitest'

export interface MockCall {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete' | 'rpc'
  payload?: unknown
  /** Filters applied via .eq()/.in()/.gte()/.like() before the terminal call. */
  filters?: Array<{ kind: string; col?: string; value?: unknown }>
}

export type SelectResult = { data: unknown; error: unknown }

export interface TableHandlers {
  /**
   * Function called when a select chain reaches a terminal (.maybeSingle() / .single()).
   * Receives the recorded filters so the test can branch on which row is being looked up.
   * If omitted, the mock returns the first item in `seed[table]` (or null).
   */
  onSelect?: (filters: MockCall['filters']) => SelectResult | Promise<SelectResult>
  /** Function called on .insert(rows).select().single() — must return the inserted row. */
  onInsert?: (payload: unknown) => SelectResult | Promise<SelectResult>
  /** Function called on .update(values).eq()...; defaults to a no-op success. */
  onUpdate?: (payload: unknown, filters: MockCall['filters']) => SelectResult | Promise<SelectResult>
}

export interface CreateMockSupabaseOptions {
  seed?: Record<string, unknown[]>
  handlers?: Record<string, TableHandlers>
  /** RPC handler — keyed by RPC name. Defaults to allow-all rate limiter. */
  rpcHandlers?: Record<string, (params: unknown) => SelectResult | Promise<SelectResult>>
}

export interface MockSupabase {
  client: {
    from: (table: string) => unknown
    rpc: (name: string, params: unknown) => Promise<SelectResult>
  }
  calls: MockCall[]
  /** Inserts grouped by table for quick lookup. */
  insertsFor(table: string): unknown[]
  /** Update payloads grouped by table. */
  updatesFor(table: string): unknown[]
}

/**
 * Build a mock Supabase client. See module docstring for behaviour.
 */
export function createMockSupabase(opts: CreateMockSupabaseOptions = {}): MockSupabase {
  const calls: MockCall[] = []
  const seed: Record<string, unknown[]> = { ...(opts.seed ?? {}) }
  const handlers: Record<string, TableHandlers> = { ...(opts.handlers ?? {}) }
  const rpcHandlers: Record<string, (params: unknown) => SelectResult | Promise<SelectResult>> = {
    // Default: allow-all rate limiter so tests don't have to wire it up.
    check_rate_limit: () => ({
      data: [{ allowed: true, remaining: 999, reset_at: new Date().toISOString() }],
      error: null,
    }),
    ...(opts.rpcHandlers ?? {}),
  }

  function makeChain(table: string) {
    const filters: MockCall['filters'] = []
    let mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let mutationPayload: unknown = undefined

    // The chain is one object whose methods return itself, plus terminal
    // resolvers that do real work.
    const chain = {
      select: (_cols?: string) => chain,
      eq: (col: string, value: unknown) => {
        filters.push({ kind: 'eq', col, value })
        return chain
      },
      in: (col: string, value: unknown) => {
        filters.push({ kind: 'in', col, value })
        return chain
      },
      gte: (col: string, value: unknown) => {
        filters.push({ kind: 'gte', col, value })
        return chain
      },
      lte: (col: string, value: unknown) => {
        filters.push({ kind: 'lte', col, value })
        return chain
      },
      like: (col: string, value: unknown) => {
        filters.push({ kind: 'like', col, value })
        return chain
      },
      ilike: (col: string, value: unknown) => {
        filters.push({ kind: 'ilike', col, value })
        return chain
      },
      not: (col: string, _op: string, value: unknown) => {
        filters.push({ kind: 'not', col, value })
        return chain
      },
      order: (_col: string, _opts?: unknown) => chain,
      limit: (_n: number) => chain,
      insert: (payload: unknown) => {
        mode = 'insert'
        mutationPayload = payload
        calls.push({ table, op: 'insert', payload })
        return chain
      },
      update: (payload: unknown) => {
        mode = 'update'
        mutationPayload = payload
        calls.push({ table, op: 'update', payload, filters })
        return chain
      },
      // upsert is recorded as an update (insert-or-update). Callers that need
      // to assert the written row can read it via `updatesFor(table)`.
      upsert: (payload: unknown, _opts?: unknown) => {
        mode = 'update'
        mutationPayload = payload
        calls.push({ table, op: 'update', payload, filters })
        return chain
      },
      delete: () => {
        mode = 'delete'
        calls.push({ table, op: 'delete', filters })
        return chain
      },
      // Terminals
      maybeSingle: async (): Promise<SelectResult> => terminal('maybeSingle'),
      single: async (): Promise<SelectResult> => terminal('single'),
      // Some chains are awaited directly (e.g. .update().eq()) — make the
      // chain a thenable so `await chain` resolves to a success result.
      then: (resolve: (v: SelectResult) => unknown, reject?: (e: unknown) => unknown) => {
        return Promise.resolve(terminal('await')).then(resolve, reject)
      },
    }

    async function terminal(_kind: string): Promise<SelectResult> {
      const tbl = handlers[table]
      if (mode === 'insert') {
        if (tbl?.onInsert) return await tbl.onInsert(mutationPayload)
        // Default: synthesize a fake id and echo the payload.
        const row = mutationPayload as Record<string, unknown> | undefined
        return { data: { id: `${table}-id-${calls.length}`, ...(row ?? {}) }, error: null }
      }
      if (mode === 'update') {
        if (tbl?.onUpdate) return await tbl.onUpdate(mutationPayload, filters)
        return { data: null, error: null }
      }
      if (mode === 'delete') {
        return { data: null, error: null }
      }
      // select
      calls.push({ table, op: 'select', filters })
      if (tbl?.onSelect) return await tbl.onSelect(filters)
      const rows = seed[table] ?? []
      return { data: rows[0] ?? null, error: null }
    }

    return chain
  }

  const client = {
    from: vi.fn((table: string) => makeChain(table)),
    rpc: vi.fn(async (name: string, params: unknown): Promise<SelectResult> => {
      calls.push({ table: `__rpc__${name}`, op: 'rpc', payload: params })
      const handler = rpcHandlers[name]
      if (handler) return await handler(params)
      return { data: null, error: null }
    }),
  }

  return {
    client,
    calls,
    insertsFor: (table: string) =>
      calls.filter((c) => c.table === table && c.op === 'insert').map((c) => c.payload),
    updatesFor: (table: string) =>
      calls.filter((c) => c.table === table && c.op === 'update').map((c) => c.payload),
  }
}
