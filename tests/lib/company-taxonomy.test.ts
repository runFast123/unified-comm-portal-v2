// Unit tests for `src/lib/company-taxonomy.ts`.
//
// Pure-ish helpers (no live DB): we exercise the colour validator directly
// and the read/validate helpers via the in-memory mock Supabase client from
// `tests/helpers/mock-supabase.ts`.

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { createMockSupabase, type MockSupabase } from '../helpers/mock-supabase'

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}))

import {
  DEFAULT_TAXONOMY_COLOR,
  getCompanyStatuses,
  getCompanyTags,
  isValidColor,
  validateSecondaryStatus,
} from '@/lib/company-taxonomy'

describe('isValidColor', () => {
  it('accepts #RRGGBB hex (any case)', () => {
    expect(isValidColor('#aabbcc')).toBe(true)
    expect(isValidColor('#AABBCC')).toBe(true)
    expect(isValidColor('#012345')).toBe(true)
  })

  it('accepts #RGB short-hex', () => {
    expect(isValidColor('#abc')).toBe(true)
    expect(isValidColor('#FFF')).toBe(true)
  })

  it('accepts a small allowlist of named CSS colors', () => {
    expect(isValidColor('red')).toBe(true)
    expect(isValidColor('Tomato')).toBe(true)
    expect(isValidColor('TEAL')).toBe(true)
  })

  it('rejects bogus values', () => {
    expect(isValidColor('not-a-color')).toBe(false)
    expect(isValidColor('rgb(0,0,0)')).toBe(false)
    expect(isValidColor('#zzz')).toBe(false)
    expect(isValidColor('')).toBe(false)
    expect(isValidColor(123 as unknown as string)).toBe(false)
    expect(isValidColor(null)).toBe(false)
    expect(isValidColor(undefined)).toBe(false)
  })

  it('rejects an obviously-wrong hex length', () => {
    expect(isValidColor('#aabb')).toBe(false)
    expect(isValidColor('#aabbccdd')).toBe(false)
  })

  it('default colour constant is itself a valid colour', () => {
    expect(isValidColor(DEFAULT_TAXONOMY_COLOR)).toBe(true)
  })
})

describe('getCompanyStatuses / getCompanyTags', () => {
  let mock: MockSupabase

  beforeEach(() => {
    mock = createMockSupabase({
      handlers: {
        company_statuses: {
          onSelect: () => ({
            data: [
              { id: 's1', company_id: 'co-a', name: 'awaiting_legal', color: '#ff0000', sort_order: 1, is_active: true, description: null, created_at: 'now' },
              { id: 's2', company_id: 'co-a', name: 'pending_review', color: '#00ff00', sort_order: 0, is_active: true, description: null, created_at: 'now' },
            ],
            error: null,
          }),
        },
        company_tags: {
          onSelect: () => ({
            data: [
              { id: 't1', company_id: 'co-a', name: 'vip', color: '#000000', description: null, created_by: null, created_at: 'now' },
            ],
            error: null,
          }),
        },
      },
    })
  })

  it('returns an empty list when companyId is empty', async () => {
    const s = await getCompanyStatuses(mock.client as never, '')
    const t = await getCompanyTags(mock.client as never, '')
    expect(s).toEqual([])
    expect(t).toEqual([])
  })

  it('fetches statuses scoped to the given company', async () => {
    const list = await getCompanyStatuses(mock.client as never, 'co-a')
    expect(list).toHaveLength(2)
    // calls were made against company_statuses
    const sel = mock.calls.filter((c) => c.table === 'company_statuses' && c.op === 'select')
    expect(sel.length).toBeGreaterThan(0)
  })

  it('fetches tags scoped to the given company', async () => {
    const list = await getCompanyTags(mock.client as never, 'co-a')
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('vip')
  })
})

describe('validateSecondaryStatus', () => {
  it('is a no-op for null / empty', async () => {
    const mock = createMockSupabase()
    await expect(validateSecondaryStatus(mock.client as never, 'co', null)).resolves.toBeUndefined()
    await expect(validateSecondaryStatus(mock.client as never, 'co', '')).resolves.toBeUndefined()
    await expect(validateSecondaryStatus(mock.client as never, 'co', '   ')).resolves.toBeUndefined()
  })

  it('throws when secondary status is set without a company scope', async () => {
    const mock = createMockSupabase()
    await expect(
      validateSecondaryStatus(mock.client as never, '', 'awaiting_legal'),
    ).rejects.toThrow(/company scope/i)
  })

  it('passes when the secondary status exists in the company catalog', async () => {
    const mock = createMockSupabase({
      handlers: {
        company_statuses: {
          onSelect: () => ({ data: { id: 's1' }, error: null }),
        },
      },
    })
    await expect(
      validateSecondaryStatus(mock.client as never, 'co-a', 'awaiting_legal'),
    ).resolves.toBeUndefined()
  })

  it('throws when the secondary status is not in the company catalog', async () => {
    const mock = createMockSupabase({
      handlers: {
        company_statuses: {
          onSelect: () => ({ data: null, error: null }),
        },
      },
    })
    await expect(
      validateSecondaryStatus(mock.client as never, 'co-a', 'orphan_label'),
    ).rejects.toThrow(/not in this company/i)
  })

  it('surfaces DB errors', async () => {
    const mock = createMockSupabase({
      handlers: {
        company_statuses: {
          onSelect: () => ({ data: null, error: { message: 'boom' } }),
        },
      },
    })
    await expect(
      validateSecondaryStatus(mock.client as never, 'co-a', 'x'),
    ).rejects.toThrow(/boom/)
  })
})
