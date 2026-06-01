// Tests for per-tenant rate limiting + monthly AI-call quota
// (`@/lib/tenant-quota`).
//
// Coverage:
//   * companyRateKey → stable `company:${id}:${action}` shape
//   * checkCompanyRateLimit forwards the COMPANY-scoped key (and max/window)
//     to the underlying boolean checkRateLimit, and returns its boolean
//   * getCompanyAiUsageThisMonth resolves company account ids, filters
//     ai_usage by `account_id IN (...)` + `ts >= start-of-UTC-month`, and
//     sums calls (row count) + tokens (input+output)
//   * checkAiQuota allows under limit / blocks at-or-over limit /
//     respects the AI_MONTHLY_CALL_LIMIT env override / FAILS OPEN on a
//     usage-read error (never hard-blocks)
//
// We mock the two module boundaries tenant-quota depends on:
//   - `@/lib/api-helpers` checkRateLimit (the boolean wrapper it composes)
//   - `@/lib/supabase-server` createServiceRoleClient (DB access), backed by
//     the shared mock-supabase helper.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockSupabase, type MockSupabase } from '../helpers/mock-supabase'

// ---- Mocks (declared before importing the module-under-test) --------

const { checkRateLimitMock } = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn<(...args: any[]) => Promise<boolean>>(async () => true),
}))

vi.mock('@/lib/api-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-helpers')>(
    '@/lib/api-helpers',
  )
  return { ...actual, checkRateLimit: checkRateLimitMock }
})

// Swappable mock-supabase instance; each test points it at fresh seed/handlers.
let mockSupabase: MockSupabase

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(async () => mockSupabase.client),
}))

// Logger is best-effort and called on the fail-open path — stub so it never
// touches the real implementation.
vi.mock('@/lib/logger', () => ({
  logError: vi.fn(async () => {}),
  logWarn: vi.fn(async () => {}),
  logInfo: vi.fn(async () => {}),
}))

import {
  companyRateKey,
  checkCompanyRateLimit,
  getCompanyAiUsageThisMonth,
  checkAiQuota,
  getAiMonthlyCallLimit,
  DEFAULT_AI_MONTHLY_CALL_LIMIT,
} from '@/lib/tenant-quota'

// ---- Helpers --------------------------------------------------------

/** Find the value of a recorded filter by kind+column on the latest matching select. */
function filterValue(
  filters: Array<{ kind: string; col?: string; value?: unknown }> | undefined,
  kind: string,
  col: string,
): unknown {
  return filters?.find((f) => f.kind === kind && f.col === col)?.value
}

const COMPANY = 'company-123'
const ACCOUNTS = ['acc-a', 'acc-b']

/**
 * Build a mock-supabase whose `accounts` select returns the given account ids
 * and whose `ai_usage` select returns the given usage rows. Captures the
 * `ts` lower-bound filter so tests can assert the UTC-month window.
 */
function seedUsage(
  accountIds: string[],
  usageRows: Array<{ input_tokens: number; output_tokens: number }>,
  opts: { aiUsageError?: unknown } = {},
): { captured: { tsGte?: unknown; accountIn?: unknown } } {
  const captured: { tsGte?: unknown; accountIn?: unknown } = {}
  mockSupabase = createMockSupabase({
    handlers: {
      accounts: {
        onSelect: () => ({
          data: accountIds.map((id) => ({ id })),
          error: null,
        }),
      },
      ai_usage: {
        onSelect: (filters) => {
          captured.tsGte = filterValue(filters, 'gte', 'ts')
          captured.accountIn = filterValue(filters, 'in', 'account_id')
          if (opts.aiUsageError) return { data: null, error: opts.aiUsageError }
          return { data: usageRows, error: null }
        },
      },
    },
  })
  return { captured }
}

// ---- Tests ----------------------------------------------------------

describe('companyRateKey', () => {
  it('produces a stable company:${id}:${action} key', () => {
    expect(companyRateKey('c1', 'ai')).toBe('company:c1:ai')
    expect(companyRateKey('abc-def', 'ai-reply')).toBe('company:abc-def:ai-reply')
  })
})

describe('checkCompanyRateLimit', () => {
  beforeEach(() => {
    checkRateLimitMock.mockReset()
    checkRateLimitMock.mockResolvedValue(true)
  })

  it('passes the COMPANY-scoped key plus max/window to the underlying limiter', async () => {
    await checkCompanyRateLimit('company-9', 'ai', 25, 60)
    expect(checkRateLimitMock).toHaveBeenCalledWith('company:company-9:ai', 25, 60)
  })

  it('returns true when the underlying limiter allows', async () => {
    checkRateLimitMock.mockResolvedValueOnce(true)
    await expect(checkCompanyRateLimit('c', 'ai', 10, 60)).resolves.toBe(true)
  })

  it('returns false when the underlying limiter denies', async () => {
    checkRateLimitMock.mockResolvedValueOnce(false)
    await expect(checkCompanyRateLimit('c', 'ai', 10, 60)).resolves.toBe(false)
  })
})

describe('getAiMonthlyCallLimit', () => {
  const original = process.env.AI_MONTHLY_CALL_LIMIT
  afterEach(() => {
    if (original === undefined) delete process.env.AI_MONTHLY_CALL_LIMIT
    else process.env.AI_MONTHLY_CALL_LIMIT = original
  })

  it('defaults to DEFAULT_AI_MONTHLY_CALL_LIMIT when env unset', () => {
    delete process.env.AI_MONTHLY_CALL_LIMIT
    expect(getAiMonthlyCallLimit()).toBe(DEFAULT_AI_MONTHLY_CALL_LIMIT)
  })

  it('honors a valid env override', () => {
    process.env.AI_MONTHLY_CALL_LIMIT = '250'
    expect(getAiMonthlyCallLimit()).toBe(250)
  })

  it('ignores a non-numeric or non-positive override (falls back to default)', () => {
    process.env.AI_MONTHLY_CALL_LIMIT = 'banana'
    expect(getAiMonthlyCallLimit()).toBe(DEFAULT_AI_MONTHLY_CALL_LIMIT)
    process.env.AI_MONTHLY_CALL_LIMIT = '0'
    expect(getAiMonthlyCallLimit()).toBe(DEFAULT_AI_MONTHLY_CALL_LIMIT)
    process.env.AI_MONTHLY_CALL_LIMIT = '-5'
    expect(getAiMonthlyCallLimit()).toBe(DEFAULT_AI_MONTHLY_CALL_LIMIT)
  })
})

describe('getCompanyAiUsageThisMonth', () => {
  it('sums calls (row count) and tokens (input + output) across company accounts', async () => {
    const { captured } = seedUsage(ACCOUNTS, [
      { input_tokens: 100, output_tokens: 50 },
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 0, output_tokens: 0 },
    ])

    const usage = await getCompanyAiUsageThisMonth(COMPANY)
    expect(usage).toEqual({ calls: 3, tokens: 165 })

    // Scoped to the company's account ids…
    expect(captured.accountIn).toEqual(ACCOUNTS)
    // …and bounded to the start of the current UTC month.
    const since = new Date(captured.tsGte as string)
    expect(since.getUTCDate()).toBe(1)
    expect(since.getUTCHours()).toBe(0)
    expect(since.getUTCMinutes()).toBe(0)
    const now = new Date()
    expect(since.getUTCFullYear()).toBe(now.getUTCFullYear())
    expect(since.getUTCMonth()).toBe(now.getUTCMonth())
  })

  it('returns zeros and skips the ai_usage query when the company has no accounts', async () => {
    seedUsage([], [{ input_tokens: 999, output_tokens: 999 }])
    const usage = await getCompanyAiUsageThisMonth(COMPANY)
    expect(usage).toEqual({ calls: 0, tokens: 0 })
    // No ai_usage select should have been issued.
    const aiUsageSelects = mockSupabase.calls.filter(
      (c) => c.table === 'ai_usage' && c.op === 'select',
    )
    expect(aiUsageSelects.length).toBe(0)
  })

  it('tolerates null token columns (treats them as 0)', async () => {
    seedUsage(ACCOUNTS, [
      { input_tokens: null as unknown as number, output_tokens: 7 },
      { input_tokens: 3, output_tokens: null as unknown as number },
    ])
    const usage = await getCompanyAiUsageThisMonth(COMPANY)
    expect(usage).toEqual({ calls: 2, tokens: 10 })
  })

  it('throws when the ai_usage read errors (so checkAiQuota can fail-open)', async () => {
    seedUsage(ACCOUNTS, [], { aiUsageError: { message: 'boom' } })
    await expect(getCompanyAiUsageThisMonth(COMPANY)).rejects.toBeTruthy()
  })
})

describe('checkAiQuota', () => {
  const original = process.env.AI_MONTHLY_CALL_LIMIT
  afterEach(() => {
    if (original === undefined) delete process.env.AI_MONTHLY_CALL_LIMIT
    else process.env.AI_MONTHLY_CALL_LIMIT = original
  })

  it('allows when month-to-date calls are under the limit', async () => {
    process.env.AI_MONTHLY_CALL_LIMIT = '5'
    seedUsage(ACCOUNTS, [
      { input_tokens: 1, output_tokens: 1 },
      { input_tokens: 1, output_tokens: 1 },
    ]) // 2 calls < 5
    const res = await checkAiQuota(COMPANY)
    expect(res.allowed).toBe(true)
    expect(res.used).toBe(2)
    expect(res.limit).toBe(5)
  })

  it('blocks when calls are at or over the limit', async () => {
    process.env.AI_MONTHLY_CALL_LIMIT = '2'
    seedUsage(ACCOUNTS, [
      { input_tokens: 1, output_tokens: 1 },
      { input_tokens: 1, output_tokens: 1 },
    ]) // 2 calls >= 2 → blocked
    const res = await checkAiQuota(COMPANY)
    expect(res.allowed).toBe(false)
    expect(res.used).toBe(2)
    expect(res.limit).toBe(2)
  })

  it('reports resetsAt as the first instant of next UTC month', async () => {
    seedUsage(ACCOUNTS, [])
    const res = await checkAiQuota(COMPANY)
    const resets = new Date(res.resetsAt)
    expect(resets.getUTCDate()).toBe(1)
    expect(resets.getUTCHours()).toBe(0)
    expect(resets.getUTCMinutes()).toBe(0)
    expect(resets.getUTCSeconds()).toBe(0)
    const now = new Date()
    // Next month is exactly one month ahead of the current UTC month start.
    const expected = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    )
    expect(resets.getTime()).toBe(expected.getTime())
    // And it is strictly in the future.
    expect(resets.getTime()).toBeGreaterThan(now.getTime())
  })

  it('FAILS OPEN (allowed:true, used:0) when usage cannot be read', async () => {
    process.env.AI_MONTHLY_CALL_LIMIT = '1'
    // ai_usage read errors → getCompanyAiUsageThisMonth throws → quota fails open.
    seedUsage(ACCOUNTS, [], { aiUsageError: { message: 'db down' } })
    const res = await checkAiQuota(COMPANY)
    expect(res.allowed).toBe(true)
    expect(res.used).toBe(0)
    expect(res.limit).toBe(1)
    // resetsAt is still populated on the fail-open path.
    expect(typeof res.resetsAt).toBe('string')
    expect(Number.isNaN(Date.parse(res.resetsAt))).toBe(false)
  })
})
