// Regression tests for POST /api/channels/config secret merging.
//
// The admin edit form never pre-fills secrets: it blanks the fields the user
// is meant to re-enter and (for secrets not shown in the form) echoes back the
// •••• mask from the masked GET. Before the merge fix, saving therefore WIPED
// any secret left blank (e.g. rotating a WhatsApp access token erased the
// stored verify_token, breaking Meta's webhook GET re-verification) and
// CORRUPTED any masked field by persisting the literal '••••••••'.
//
// These tests run the real route handler + real channel-config merge logic
// with supabase/encryption mocked, and assert:
//   * blank secret  + stored value → stored value kept
//   * mask placeholder             → stored value kept (mask never persisted)
//   * non-empty new value          → replaces the stored secret
//   * create path (no stored row)  → unchanged: required secrets still 400
//   * telegram webhook_secret stays server-managed (kept only while the bot
//     token is unchanged) — the merge must not resurrect it past that guard

import { describe, it, expect, beforeEach } from 'vitest'
import { vi } from 'vitest'

const fixture = {
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'admin',
  accessAllowed: true,
  permitted: true,
  /** Decrypted stored config for the channel_configs row, or null = no row. */
  stored: null as Record<string, unknown> | null,
  upserts: [] as Array<Record<string, unknown>>,
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: fixture.user } }) },
  }),
  createServiceRoleClient: async () => ({
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      Object.assign(c, {
        select: () => c,
        eq: () => c,
        maybeSingle: async () => {
          if (table === 'users') return { data: fixture.user ? { role: fixture.role } : null }
          if (table === 'channel_configs') {
            return {
              data: fixture.stored
                ? { config_encrypted: JSON.stringify(fixture.stored) }
                : null,
            }
          }
          return { data: null }
        },
        upsert: (payload: Record<string, unknown>) => {
          fixture.upserts.push(payload)
          return { error: null }
        },
        insert: () => ({ error: null }), // audit_log
      })
      return c
    },
  }),
}))

// In tests the "ciphertext" is the plaintext JSON.
vi.mock('@/lib/encryption', () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}))

vi.mock('@/lib/logger', () => ({ logError: vi.fn(async () => {}) }))

vi.mock('@/lib/api-helpers', () => ({
  verifyAccountAccess: vi.fn(async () => fixture.accessAllowed),
}))

vi.mock('@/lib/permissions/server', () => ({
  userIdCan: vi.fn(async () => fixture.permitted),
}))

import { POST } from '@/app/api/channels/config/route'
import { SECRET_MASK } from '@/lib/channel-config'

function req(body: unknown): Request {
  return new Request('http://localhost/api/channels/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The decrypted config written by the (sole) upsert. */
function savedConfig(): Record<string, unknown> {
  expect(fixture.upserts).toHaveLength(1)
  return JSON.parse(fixture.upserts[0].config_encrypted as string)
}

beforeEach(() => {
  fixture.user = { id: 'admin-1' }
  fixture.role = 'admin'
  fixture.accessAllowed = true
  fixture.permitted = true
  fixture.stored = null
  fixture.upserts = []
})

describe('POST /api/channels/config — secret merge', () => {
  it('REGRESSION: rotating the whatsapp access token with verify_token left blank keeps the stored verify_token', async () => {
    fixture.stored = {
      phone_number_id: '111',
      access_token: 'old-access-token',
      verify_token: 'stored-verify-token',
      app_secret: 'stored-app-secret',
      graph_version: 'v21.0',
    }
    const res = await POST(req({
      account_id: 'acct-1',
      channel: 'whatsapp',
      config: {
        phone_number_id: '111',
        access_token: 'new-rotated-token',
        verify_token: '', // edit form blanks secrets — must NOT wipe
        app_secret: '',
        graph_version: 'v21.0',
      },
    }))
    expect(res.status).toBe(200)
    const saved = savedConfig()
    expect(saved.access_token).toBe('new-rotated-token') // new value replaces
    expect(saved.verify_token).toBe('stored-verify-token') // blank keeps stored
    expect(saved.app_secret).toBe('stored-app-secret')
  })

  it('a non-empty new verify_token replaces the stored one', async () => {
    fixture.stored = {
      phone_number_id: '111',
      access_token: 'old-access-token',
      verify_token: 'stored-verify-token',
      graph_version: 'v21.0',
    }
    const res = await POST(req({
      account_id: 'acct-1',
      channel: 'whatsapp',
      config: {
        phone_number_id: '111',
        access_token: '',
        verify_token: 'brand-new-verify',
        graph_version: 'v21.0',
      },
    }))
    expect(res.status).toBe(200)
    const saved = savedConfig()
    expect(saved.verify_token).toBe('brand-new-verify')
    // ...and the blank required secret survived too (merged before validation)
    expect(saved.access_token).toBe('old-access-token')
  })

  it('the •••• mask round-trips to the stored value — never persisted literally', async () => {
    fixture.stored = {
      phone_number_id: '111',
      access_token: 'old-access-token',
      verify_token: 'stored-verify-token',
      graph_version: 'v21.0',
    }
    const res = await POST(req({
      account_id: 'acct-1',
      channel: 'whatsapp',
      config: {
        phone_number_id: '111',
        access_token: SECRET_MASK,
        verify_token: SECRET_MASK,
        graph_version: 'v21.0',
      },
    }))
    expect(res.status).toBe(200)
    const saved = savedConfig()
    expect(saved.access_token).toBe('old-access-token')
    expect(saved.verify_token).toBe('stored-verify-token')
  })

  it('masked secrets NOT shown in the edit form (teams delegated_refresh_token) survive a credential rotation', async () => {
    fixture.stored = {
      azure_tenant_id: 'tenant-1',
      azure_client_id: 'client-1',
      azure_client_secret: 'old-secret',
      auth_mode: 'delegated',
      delegated_refresh_token: 'refresh-token-1',
    }
    // The form blanks azure_client_secret for re-entry; delegated_refresh_token
    // is not a form field so the masked GET value is echoed back verbatim.
    const res = await POST(req({
      account_id: 'acct-1',
      channel: 'teams',
      config: {
        azure_tenant_id: 'tenant-1',
        azure_client_id: 'client-1',
        azure_client_secret: 'new-secret',
        auth_mode: 'delegated',
        delegated_refresh_token: SECRET_MASK,
      },
    }))
    expect(res.status).toBe(200)
    const saved = savedConfig()
    expect(saved.azure_client_secret).toBe('new-secret')
    expect(saved.delegated_refresh_token).toBe('refresh-token-1')
  })

  it('covers every channel via the server SECRET_FIELDS list (messenger spot-check)', async () => {
    fixture.stored = {
      page_id: 'page-1',
      page_access_token: 'pat-old',
      verify_token: 'vt-messenger',
      app_secret: 'as-messenger',
    }
    const res = await POST(req({
      account_id: 'acct-1',
      channel: 'messenger',
      config: { page_id: 'page-1', page_access_token: '', verify_token: '', app_secret: '' },
    }))
    expect(res.status).toBe(200)
    const saved = savedConfig()
    expect(saved.page_access_token).toBe('pat-old')
    expect(saved.verify_token).toBe('vt-messenger')
    expect(saved.app_secret).toBe('as-messenger')
  })

  it('create path (no stored row): a blank required secret still 400s, nothing saved', async () => {
    fixture.stored = null
    const res = await POST(req({
      account_id: 'acct-1',
      channel: 'whatsapp',
      config: { phone_number_id: '111', access_token: '', graph_version: 'v21.0' },
    }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('access_token')
    expect(fixture.upserts).toHaveLength(0)
  })

  it('create path: a mask with no stored value is coerced to empty, not persisted', async () => {
    fixture.stored = null
    const res = await POST(req({
      account_id: 'acct-1',
      channel: 'whatsapp',
      config: { phone_number_id: '111', access_token: SECRET_MASK, graph_version: 'v21.0' },
    }))
    // Coerced to '' → fails the required check rather than storing '••••••••'
    expect(res.status).toBe(400)
    expect(fixture.upserts).toHaveLength(0)
  })

  it('create path: an optional secret left blank stays blank', async () => {
    fixture.stored = null
    const res = await POST(req({
      account_id: 'acct-1',
      channel: 'whatsapp',
      config: { phone_number_id: '111', access_token: 'at-1', verify_token: '', graph_version: 'v21.0' },
    }))
    expect(res.status).toBe(200)
    expect(savedConfig().verify_token).toBe('')
  })

  it('telegram: blank bot_token keeps the stored token AND the server-managed webhook_secret', async () => {
    fixture.stored = { bot_token: 'bt-old', webhook_secret: 'whsec-1' }
    const res = await POST(req({
      account_id: 'acct-1',
      channel: 'telegram',
      config: { bot_token: '' },
    }))
    expect(res.status).toBe(200)
    const saved = savedConfig()
    expect(saved.bot_token).toBe('bt-old')
    expect(saved.webhook_secret).toBe('whsec-1')
  })

  it('telegram: a NEW bot_token still drops webhook_secret — the merge must not resurrect it', async () => {
    fixture.stored = { bot_token: 'bt-old', webhook_secret: 'whsec-1' }
    const res = await POST(req({
      account_id: 'acct-1',
      channel: 'telegram',
      config: { bot_token: 'bt-new' },
    }))
    expect(res.status).toBe(200)
    const saved = savedConfig()
    expect(saved.bot_token).toBe('bt-new')
    expect(saved.webhook_secret).toBeUndefined()
  })
})
