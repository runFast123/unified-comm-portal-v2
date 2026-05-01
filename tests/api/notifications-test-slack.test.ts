/**
 * Tests for POST /api/admin/notifications/test-slack
 *
 * Coverage:
 *   - 401 when unauthenticated
 *   - 403 when caller is a plain member (no admin role)
 *   - 400 on invalid JSON body
 *   - 400 when webhook_url is missing or not a Slack URL
 *   - 502 when Slack rejects the test message
 *   - 200 + ok:true on a successful Slack POST, with the Block Kit body
 *     containing the "test notification" preview text.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

vi.mock('@/lib/logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

interface Profile {
  id: string
  email: string
  full_name: string | null
  role: string
  account_id: string | null
  company_id: string | null
}

const fixture = {
  user: null as { id: string } | null,
  profile: null as Profile | null,
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: fixture.user }, error: null }),
    },
  })),
  // Auth's getCurrentUser uses createServiceRoleClient — return the profile.
  createServiceRoleClient: vi.fn(async () => ({
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: fixture.profile, error: null }),
        }),
      }),
    }),
  })),
}))

import { POST as testSlackPOST } from '@/app/api/admin/notifications/test-slack/route'

interface FetchCall {
  url: string
  init?: RequestInit
}

const fetchCalls: FetchCall[] = []
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>

beforeEach(() => {
  fetchCalls.length = 0
  fetchImpl = async () => new Response('ok', { status: 200 })
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    fetchCalls.push({ url, init })
    return fetchImpl(url, init)
  }) as unknown as typeof fetch

  fixture.user = { id: 'user-1' }
  fixture.profile = {
    id: 'user-1',
    email: 'admin@x.example',
    full_name: 'Admin',
    role: 'company_admin',
    account_id: null,
    company_id: 'comp-a',
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonReq(body?: unknown, raw?: string): Request {
  return new Request('http://localhost/api/admin/notifications/test-slack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/admin/notifications/test-slack', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await testSlackPOST(
      jsonReq({ webhook_url: 'https://hooks.slack.com/services/T/B/X' })
    )
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  it('403 when caller is a plain member', async () => {
    fixture.profile!.role = 'company_member'
    const res = await testSlackPOST(
      jsonReq({ webhook_url: 'https://hooks.slack.com/services/T/B/X' })
    )
    expect(res.status).toBe(403)
  })

  it('403 when profile is missing entirely', async () => {
    fixture.profile = null
    const res = await testSlackPOST(
      jsonReq({ webhook_url: 'https://hooks.slack.com/services/T/B/X' })
    )
    expect(res.status).toBe(403)
  })

  it('400 on invalid JSON body', async () => {
    const res = await testSlackPOST(jsonReq(undefined, 'not-json'))
    expect(res.status).toBe(400)
  })

  it('400 when webhook_url is missing', async () => {
    const res = await testSlackPOST(jsonReq({}))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/webhook_url/i)
  })

  it('400 when webhook_url is not a Slack URL', async () => {
    const res = await testSlackPOST(jsonReq({ webhook_url: 'https://evil.example/post' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/slack/i)
    expect(fetchCalls).toHaveLength(0)
  })

  it('502 when Slack rejects the test (non-2xx response)', async () => {
    fetchImpl = async () => new Response('invalid_payload', { status: 400 })
    const res = await testSlackPOST(
      jsonReq({ webhook_url: 'https://hooks.slack.com/services/T/B/X' })
    )
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  it('200 + ok:true on successful Slack POST', async () => {
    const res = await testSlackPOST(
      jsonReq({ webhook_url: 'https://hooks.slack.com/services/T/B/X' })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    // Slack received exactly one call with our Block Kit payload.
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://hooks.slack.com/services/T/B/X')
    const slackBody = JSON.parse(String(fetchCalls[0].init?.body))
    expect(slackBody.blocks).toBeDefined()
    expect(slackBody.text).toBeDefined()
    // The preview should contain our standard test message.
    const previewBlock = slackBody.blocks.find(
      (b: { type: string; text?: { text?: string } }) =>
        b.type === 'section' && b.text?.text?.includes('test notification')
    )
    expect(previewBlock).toBeDefined()
  })

  it('super_admin is allowed too', async () => {
    fixture.profile!.role = 'super_admin'
    fixture.profile!.company_id = null
    const res = await testSlackPOST(
      jsonReq({ webhook_url: 'https://hooks.slack.com/services/T/B/X' })
    )
    expect(res.status).toBe(200)
  })
})
