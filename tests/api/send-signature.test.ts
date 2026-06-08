/**
 * Tests for the email-signature integration in POST /api/send.
 *
 *   * append_signature defaults to true → resolved signature is appended
 *     to the body that ends up in `sendEmail` (and the pending_sends row).
 *   * append_signature: false → no append even when a signature exists.
 *   * Non-email channels never receive a signature regardless of flag.
 *   * Resolver throwing does not block the send (graceful fallback).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// The send route now gates on action:message.send + channel:*; grant them here.
vi.mock('@/lib/permissions/server', () => ({
  userIdCan: vi.fn(async () => true),
}))

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

const { sendEmailMock, sendTeamsMock, sendWhatsAppMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(async () => ({ ok: true, provider_message_id: 'pm-1' })),
  sendTeamsMock: vi.fn(async () => ({ ok: true, provider_message_id: 'pm-1' })),
  sendWhatsAppMock: vi.fn(async () => ({ ok: true, provider_message_id: 'pm-1' })),
}))
vi.mock('@/lib/channel-sender', () => ({
  sendEmail: sendEmailMock,
  sendTeams: sendTeamsMock,
  sendWhatsApp: sendWhatsAppMock,
}))

vi.mock('@/lib/api-helpers', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api-helpers')>()
  return { ...actual, checkRateLimit: vi.fn(async () => true) }
})

vi.mock('@/lib/logger', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const { resolveSignatureMock, appendSignatureToBodyMock } = vi.hoisted(() => ({
  resolveSignatureMock: vi.fn(async () => null as string | null),
  // Pass-through real implementation for `appendSignatureToBody` so we can
  // assert on the realistic delimiter format. Replicated inline to avoid
  // pulling in the actual module (which would defeat the mock).
  appendSignatureToBodyMock: vi.fn((body: string, sig: string | null) => {
    if (!sig || sig.trim().length === 0) return body
    return `${body.replace(/\s+$/g, '')}\n\n---\n${sig.trim()}`
  }),
}))
vi.mock('@/lib/email-signature', () => ({
  resolveSignature: resolveSignatureMock,
  appendSignatureToBody: appendSignatureToBodyMock,
}))

const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  profile: { role: 'admin', account_id: 'acc-1' } as { role: string; account_id: string } | null,
  conversation: { id: 'conv-1', account_id: 'acc-1', channel: 'email' } as
    | { id: string; account_id: string; channel: string }
    | null,
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      ;(chain as { select: () => unknown }).select = () => chain
      ;(chain as { eq: () => unknown }).eq = () => chain
      ;(chain as { in: () => unknown }).in = () => chain
      ;(chain as { gte: () => unknown }).gte = () => chain
      ;(chain as { limit: () => unknown }).limit = () => chain
      ;(chain as { insert: () => unknown }).insert = () => chain
      ;(chain as { update: () => unknown }).update = () => chain
      ;(chain as { single: () => Promise<{ data: unknown; error: unknown }> }).single = async () => ({ data: null, error: null })
      ;(chain as { maybeSingle: () => Promise<{ data: unknown; error: unknown }> }).maybeSingle = async () => {
        if (table === 'users') return { data: fixture.profile, error: null }
        if (table === 'conversations') return { data: fixture.conversation, error: null }
        return { data: null, error: null }
      }
      ;(chain as { then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => unknown }).then = (resolve) =>
        resolve({ data: null, error: null })
      return chain
    },
  }
}

function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: fixture.user }, error: null }),
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

import { POST } from '@/app/api/send/route'

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const emailBase = {
  channel: 'email' as const,
  account_id: 'acc-1',
  conversation_id: 'conv-1',
  reply_text: 'Hello there.',
  to: 'customer@example.com',
  subject: 'Re: ticket',
}

beforeEach(() => {
  sendEmailMock.mockClear()
  sendTeamsMock.mockClear()
  sendWhatsAppMock.mockClear()
  resolveSignatureMock.mockClear()
  resolveSignatureMock.mockResolvedValue(null)
  appendSignatureToBodyMock.mockClear()
  fixture.user = { id: 'user-1' }
  fixture.profile = { role: 'admin', account_id: 'acc-1' }
  fixture.conversation = { id: 'conv-1', account_id: 'acc-1', channel: 'email' }
})

describe('POST /api/send — signature appending', () => {
  it('appends the resolved signature when append_signature is omitted (default true)', async () => {
    resolveSignatureMock.mockResolvedValue('Jane Doe\nAcme')
    const res = await POST(makeRequest(emailBase))
    expect(res.status).toBe(200)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const arg = (sendEmailMock.mock.calls as unknown as Array<[{ body: string }]>)[0][0]
    expect(arg.body).toBe('Hello there.\n\n---\nJane Doe\nAcme')
  })

  it('does NOT append when append_signature is false', async () => {
    resolveSignatureMock.mockResolvedValue('Jane Doe\nAcme')
    const res = await POST(makeRequest({ ...emailBase, append_signature: false }))
    expect(res.status).toBe(200)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const arg = (sendEmailMock.mock.calls as unknown as Array<[{ body: string }]>)[0][0]
    expect(arg.body).toBe('Hello there.')
    // Resolver shouldn't even be called when we know we're skipping the append.
    expect(resolveSignatureMock).not.toHaveBeenCalled()
  })

  it('sends body unchanged when no signature is configured', async () => {
    resolveSignatureMock.mockResolvedValue(null)
    const res = await POST(makeRequest(emailBase))
    expect(res.status).toBe(200)
    const arg = (sendEmailMock.mock.calls as unknown as Array<[{ body: string }]>)[0][0]
    expect(arg.body).toBe('Hello there.')
  })

  it('Teams channel: signature is NEVER resolved or appended', async () => {
    fixture.conversation = { id: 'conv-1', account_id: 'acc-1', channel: 'teams' }
    resolveSignatureMock.mockResolvedValue('SHOULD-NOT-APPEAR')
    const res = await POST(
      makeRequest({
        channel: 'teams',
        account_id: 'acc-1',
        conversation_id: 'conv-1',
        reply_text: 'Plain teams message',
        teams_chat_id: 'chat-1',
      }),
    )
    expect(res.status).toBe(200)
    expect(sendTeamsMock).toHaveBeenCalledTimes(1)
    const arg = (sendTeamsMock.mock.calls as unknown as Array<[{ body: string }]>)[0][0]
    expect(arg.body).toBe('Plain teams message')
    expect(resolveSignatureMock).not.toHaveBeenCalled()
  })

  it('resolver failure is non-fatal — sends original body', async () => {
    resolveSignatureMock.mockRejectedValue(new Error('boom'))
    const res = await POST(makeRequest(emailBase))
    expect(res.status).toBe(200)
    const arg = (sendEmailMock.mock.calls as unknown as Array<[{ body: string }]>)[0][0]
    expect(arg.body).toBe('Hello there.')
  })
})
