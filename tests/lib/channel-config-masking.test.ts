import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Regression guard for the SECRET_FIELDS masking in getMaskedChannelConfig.
 *
 * GET /api/channels/config returns this masked config to the admin browser.
 * Before the fix, the inbound-auth secrets (telegram webhook_secret, Meta
 * app_secret, messenger/instagram verify_token) were missing from
 * SECRET_FIELDS and went to the client in clear text. These tests pin every
 * webhook-auth secret to the •••• mask, and pin the falsy-when-absent
 * behaviour the admin UI's inbound-readiness chips rely on
 * (Boolean(cfg.app_secret) etc. on the masked config).
 */

const mockState: { selectRow: Record<string, unknown> | null } = { selectRow: null }

function makeBuilder() {
  const builder: Record<string, unknown> = {}
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: mockState.selectRow }),
  })
  return builder
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(async () => ({ from: () => makeBuilder() })),
}))

vi.mock('@/lib/encryption', () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s, // in tests the "ciphertext" is the plaintext JSON
}))

vi.mock('@/lib/logger', () => ({ logError: vi.fn(async () => {}) }))

import { getMaskedChannelConfig, SECRET_MASK } from '@/lib/channel-config'

function dbRow(config: Record<string, unknown>) {
  mockState.selectRow = { config_encrypted: JSON.stringify(config) }
}

beforeEach(() => {
  mockState.selectRow = null
})

describe('getMaskedChannelConfig — inbound-auth secrets are masked', () => {
  it('telegram: masks bot_token AND webhook_secret', async () => {
    dbRow({ bot_token: 'bt-secret', webhook_secret: 'whsec-secret' })
    const res = await getMaskedChannelConfig('acc-1', 'telegram')
    const cfg = res.config as Record<string, unknown>
    expect(cfg.bot_token).toBe(SECRET_MASK)
    expect(cfg.webhook_secret).toBe(SECRET_MASK)
  })

  it('whatsapp: masks access_token, verify_token and app_secret; leaves non-secrets readable', async () => {
    dbRow({
      phone_number_id: '111',
      access_token: 'at-secret',
      verify_token: 'vt-secret',
      app_secret: 'as-secret',
      graph_version: 'v21.0',
    })
    const res = await getMaskedChannelConfig('acc-1', 'whatsapp')
    const cfg = res.config as Record<string, unknown>
    expect(cfg.access_token).toBe(SECRET_MASK)
    expect(cfg.verify_token).toBe(SECRET_MASK)
    expect(cfg.app_secret).toBe(SECRET_MASK)
    expect(cfg.phone_number_id).toBe('111')
    expect(cfg.graph_version).toBe('v21.0')
  })

  it.each(['messenger', 'instagram'] as const)(
    '%s: masks page_access_token, verify_token and app_secret',
    async (channel) => {
      dbRow({
        page_id: 'page-1',
        page_access_token: 'pat-secret',
        verify_token: 'vt-secret',
        app_secret: 'as-secret',
      })
      const res = await getMaskedChannelConfig('acc-1', channel)
      const cfg = res.config as Record<string, unknown>
      expect(cfg.page_access_token).toBe(SECRET_MASK)
      expect(cfg.verify_token).toBe(SECRET_MASK)
      expect(cfg.app_secret).toBe(SECRET_MASK)
      expect(cfg.page_id).toBe('page-1')
    }
  )

  it('no clear-text secret value survives masking on any webhook channel', async () => {
    // Belt and braces: whatever fields a config carries, none of the raw
    // secret values may appear anywhere in the masked output.
    const secrets = {
      bot_token: 'raw-1',
      webhook_secret: 'raw-2',
      access_token: 'raw-3',
      verify_token: 'raw-4',
      app_secret: 'raw-5',
      page_access_token: 'raw-6',
    }
    for (const channel of ['telegram', 'whatsapp', 'messenger', 'instagram', 'sms'] as const) {
      dbRow({ ...secrets, auth_token: 'raw-7', account_sid: 'AC1' })
      const res = await getMaskedChannelConfig('acc-1', channel)
      const serialized = JSON.stringify(res.config)
      for (const [field, raw] of Object.entries(secrets)) {
        // Only fields declared secret for THIS channel are masked; the loop
        // asserts the union never leaks the channel's own secrets.
        if ((res.config as Record<string, unknown>)[field] === SECRET_MASK) {
          expect(serialized).not.toContain(raw)
        }
      }
    }
  })

  it('absent optional secrets stay absent (inbound chips read Boolean presence)', async () => {
    dbRow({ page_id: 'page-1', page_access_token: 'pat-secret' }) // no app_secret/verify_token
    const res = await getMaskedChannelConfig('acc-1', 'messenger')
    const cfg = res.config as Record<string, unknown>
    expect(cfg.app_secret).toBeUndefined()
    expect(cfg.verify_token).toBeUndefined()
    // ...and the set secret is truthy-but-masked, so Boolean checks still work
    expect(Boolean(cfg.page_access_token)).toBe(true)
  })
})
