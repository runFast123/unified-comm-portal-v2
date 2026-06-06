import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Coverage for the BYOC Test-Connection gate persistence:
 *  - getMaskedChannelConfig surfaces the saved last_tested_at / last_test_ok
 *    (the data contract the admin "Verified / Failed / Not tested" badge reads).
 *  - recordChannelConfigTest writes the result scoped to (account_id, channel).
 *
 * The supabase service-role client is mocked as a chainable builder so we can
 * both feed a row into the read path and capture the write path's arguments.
 */

const mockState: {
  selectRow: Record<string, unknown> | null
  captured: { table: string | null; update: Record<string, unknown> | null; eqs: Array<[string, unknown]> }
} = {
  selectRow: null,
  captured: { table: null, update: null, eqs: [] },
}

function makeBuilder() {
  const builder: Record<string, unknown> = {}
  Object.assign(builder, {
    select: () => builder,
    update: (vals: Record<string, unknown>) => {
      mockState.captured.update = vals
      return builder
    },
    eq: (col: string, val: unknown) => {
      mockState.captured.eqs.push([col, val])
      return builder
    },
    maybeSingle: async () => ({ data: mockState.selectRow }),
    // Makes `await builder` (the tail of recordChannelConfigTest's update chain)
    // resolve without a real DB.
    then: (resolve: (v: unknown) => void) => resolve({ error: null }),
  })
  return builder
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(async () => ({
    from: (table: string) => {
      mockState.captured.table = table
      return makeBuilder()
    },
  })),
}))

vi.mock('@/lib/encryption', () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s, // in tests the "ciphertext" is the plaintext JSON
}))

vi.mock('@/lib/logger', () => ({ logError: vi.fn(async () => {}) }))

import { getMaskedChannelConfig, recordChannelConfigTest } from '@/lib/channel-config'

beforeEach(() => {
  mockState.selectRow = null
  mockState.captured = { table: null, update: null, eqs: [] }
})

describe('BYOC Test-Connection gate persistence', () => {
  it('getMaskedChannelConfig surfaces persisted test status for a db config', async () => {
    mockState.selectRow = {
      config_encrypted: JSON.stringify({ bot_token: 'secret123' }),
      last_tested_at: '2026-06-06T10:00:00.000Z',
      last_test_ok: true,
    }
    const res = await getMaskedChannelConfig('acc-1', 'telegram')
    expect(res.source).toBe('db')
    expect(res.config?.bot_token).toBe('••••••••') // secret masked
    expect(res.lastTestedAt).toBe('2026-06-06T10:00:00.000Z')
    expect(res.lastTestOk).toBe(true)
  })

  it('returns null test status when there is no saved (db) row', async () => {
    mockState.selectRow = null // env/none fallback path
    const res = await getMaskedChannelConfig('acc-1', 'telegram')
    expect(res.lastTestedAt).toBeNull()
    expect(res.lastTestOk).toBeNull()
  })

  it('recordChannelConfigTest persists a passing result scoped to account+channel', async () => {
    await recordChannelConfigTest('acc-9', 'sms', true)
    expect(mockState.captured.table).toBe('channel_configs')
    expect(mockState.captured.update).toMatchObject({ last_test_ok: true, last_test_error: null })
    expect(typeof mockState.captured.update?.last_tested_at).toBe('string')
    // Scoped to exactly this tenant's account + channel — never a blind update.
    expect(mockState.captured.eqs).toEqual([
      ['account_id', 'acc-9'],
      ['channel', 'sms'],
    ])
  })

  it('recordChannelConfigTest stores the error text on failure', async () => {
    await recordChannelConfigTest('acc-9', 'sms', false, 'bad token')
    expect(mockState.captured.update).toMatchObject({ last_test_ok: false, last_test_error: 'bad token' })
  })

  it('recordChannelConfigTest defaults the error text when none is given', async () => {
    await recordChannelConfigTest('acc-9', 'sms', false)
    expect(mockState.captured.update?.last_test_error).toBe('Test failed')
  })
})
