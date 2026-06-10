// Tests for POST /api/channels/test-message — end-to-end outbound proof.
//
// Verifies:
//   * Auth gating (401), account-scope guard (403), RBAC credentials.manage (403)
//   * Rate limit (429) — the route double-limits per-account AND per-user
//   * email = SELF-send only (recipient is the account's own mailbox — the
//     caller can never choose it, so the endpoint can't be used as a relay)
//   * sms requires a valid E.164 destination (caller-chosen, which is why the
//     route is gated on credentials.manage: those users already control the
//     Twilio creds and could send freely with them anyway)
//   * other channels are rejected (400) with guidance
//   * provider failure surfaces as 502

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  accessAllowed: true,
  permitted: true,
  rateOk: true,
  account: {
    id: 'acct-1',
    name: 'Support Mailbox',
    channel_type: 'email',
    gmail_address: 'support@example.com',
    is_active: true,
  } as Record<string, unknown> | null,
  sendResult: { ok: true } as { ok: boolean; error?: string },
  sends: [] as Array<{ channel: string; msg: Record<string, unknown> }>,
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: fixture.user } }) },
  }),
  createServiceRoleClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: fixture.account, error: fixture.account ? null : { message: 'not found' } }),
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/api-helpers', () => ({
  verifyAccountAccess: vi.fn(async () => fixture.accessAllowed),
  checkRateLimit: vi.fn(async () => fixture.rateOk),
}))

vi.mock('@/lib/permissions/server', () => ({
  userIdCan: vi.fn(async () => fixture.permitted),
  userHasPermission: vi.fn(async () => true),
  getEffectivePermissions: vi.fn(async () => new Set<string>()),
}))

vi.mock('@/lib/channels/adapters', () => ({
  sendViaChannel: vi.fn(async (channel: string, msg: Record<string, unknown>) => {
    fixture.sends.push({ channel, msg })
    return fixture.sendResult
  }),
}))

import { POST } from '@/app/api/channels/test-message/route'

function req(body: unknown): Request {
  return new Request('http://localhost/api/channels/test-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  fixture.user = { id: 'user-1' }
  fixture.accessAllowed = true
  fixture.permitted = true
  fixture.rateOk = true
  fixture.account = {
    id: 'acct-1',
    name: 'Support Mailbox',
    channel_type: 'email',
    gmail_address: 'support@example.com',
    is_active: true,
  }
  fixture.sendResult = { ok: true }
  fixture.sends = []
})

describe('POST /api/channels/test-message', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await POST(req({ account_id: 'acct-1' }))
    expect(res.status).toBe(401)
  })

  it('403 when the caller lacks account access', async () => {
    fixture.accessAllowed = false
    const res = await POST(req({ account_id: 'acct-1' }))
    expect(res.status).toBe(403)
    expect(fixture.sends).toHaveLength(0)
  })

  it('403 when RBAC denies action:credentials.manage', async () => {
    fixture.permitted = false
    const res = await POST(req({ account_id: 'acct-1' }))
    expect(res.status).toBe(403)
    expect(fixture.sends).toHaveLength(0)
  })

  it('429 when rate-limited', async () => {
    fixture.rateOk = false
    const res = await POST(req({ account_id: 'acct-1' }))
    expect(res.status).toBe(429)
  })

  it('email: self-sends to the account mailbox, ignoring any caller-supplied recipient', async () => {
    const res = await POST(req({ account_id: 'acct-1', to: 'attacker@evil.com' }))
    expect(res.status).toBe(200)
    expect(fixture.sends).toHaveLength(1)
    expect(fixture.sends[0].channel).toBe('email')
    expect(fixture.sends[0].msg.to).toBe('support@example.com')
  })

  it('email: 400 when the account has no mailbox address', async () => {
    fixture.account = { ...fixture.account!, gmail_address: null }
    const res = await POST(req({ account_id: 'acct-1' }))
    expect(res.status).toBe(400)
    expect(fixture.sends).toHaveLength(0)
  })

  it('sms: requires a valid E.164 destination', async () => {
    fixture.account = { ...fixture.account!, channel_type: 'sms' }
    expect((await POST(req({ account_id: 'acct-1' }))).status).toBe(400)
    expect((await POST(req({ account_id: 'acct-1', to: '4155552671' }))).status).toBe(400)
    const ok = await POST(req({ account_id: 'acct-1', to: '+14155552671' }))
    expect(ok.status).toBe(200)
    expect(fixture.sends).toHaveLength(1)
    expect(fixture.sends[0].msg.to).toBe('+14155552671')
  })

  it('400 for channels where a cold test-send is not possible', async () => {
    fixture.account = { ...fixture.account!, channel_type: 'telegram' }
    const res = await POST(req({ account_id: 'acct-1' }))
    expect(res.status).toBe(400)
    expect(fixture.sends).toHaveLength(0)
  })

  it('403 when the account is inactive', async () => {
    fixture.account = { ...fixture.account!, is_active: false }
    const res = await POST(req({ account_id: 'acct-1' }))
    expect(res.status).toBe(403)
  })

  it('502 when the provider send fails', async () => {
    fixture.sendResult = { ok: false, error: 'SMTP auth failed' }
    const res = await POST(req({ account_id: 'acct-1' }))
    expect(res.status).toBe(502)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toContain('SMTP auth failed')
  })
})
