/**
 * Tests for the Slack-notification path in src/lib/notification-service.ts.
 *
 * Coverage:
 *   - buildSlackPayload  → shape conforms to Slack Block Kit (text + 3 blocks,
 *                          mrkdwn header, quoted preview, action button URL).
 *   - sendSlackNotification → success path POSTs JSON, returns true.
 *                           → 5xx response returns false (does not throw).
 *                           → network throw returns false.
 *                           → 5s timeout aborts the fetch (returns false).
 *   - triggerNotifications → spam-flagged messages are skipped (no fetch).
 *                          → min_priority filter: medium message + high rule
 *                            → no Slack delivery.
 *                          → matching rule triggers exactly one Slack POST
 *                            with the expected webhook URL + Block Kit body.
 *                          → notify_slack=false rule is ignored.
 *                          → Slack 500 must NOT throw out of triggerNotifications.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Logger mock — silences logInfo/logError and lets us assert calls.
const logInfo = vi.fn()
const logError = vi.fn()
vi.mock('@/lib/logger', () => ({
  logInfo: (...args: unknown[]) => logInfo(...args),
  logError: (...args: unknown[]) => logError(...args),
}))

// nodemailer mock — we only care about Slack here, but triggerNotifications
// will reach for it if SMTP env vars are set. Stub the transport so it does
// nothing.
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: vi.fn(async () => ({ messageId: 'stub' })),
    }),
  },
}))

import {
  buildSlackPayload,
  sendSlackNotification,
  triggerNotifications,
  type NotificationMessageData,
} from '@/lib/notification-service'

interface FetchCall {
  url: string
  init?: RequestInit
}

const fetchCalls: FetchCall[] = []
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>

beforeEach(() => {
  fetchCalls.length = 0
  logInfo.mockReset()
  logError.mockReset()
  // Default: every fetch returns a 200 OK from Slack.
  fetchImpl = async () => new Response('ok', { status: 200 })
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    fetchCalls.push({ url, init })
    return fetchImpl(url, init)
  }) as unknown as typeof fetch
  // Avoid SMTP path side-effects in triggerNotifications.
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASSWORD
  process.env.NEXT_PUBLIC_SITE_URL = 'https://portal.example'
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── buildSlackPayload ─────────────────────────────────────────────────

describe('buildSlackPayload', () => {
  const base = {
    channelLabel: 'Email',
    priority: 'URGENT',
    accountName: 'MCM',
    senderName: 'John Doe',
    senderEmail: 'john@example.com',
    subject: 'Need help with order',
    preview: 'Hi team, my order #1234 has not arrived yet.',
    conversationUrl: 'https://portal.example/conversations/conv-abc',
  }

  it('produces a fallback text + 3 blocks', () => {
    const p = buildSlackPayload(base)
    expect(p.text).toContain('John Doe')
    expect(p.text.toLowerCase()).toContain('email')
    expect(p.blocks).toHaveLength(3)
  })

  it('header block is mrkdwn with from/account/subject', () => {
    const header = buildSlackPayload(base).blocks[0] as {
      type: string
      text: { type: string; text: string }
    }
    expect(header.type).toBe('section')
    expect(header.text.type).toBe('mrkdwn')
    expect(header.text.text).toContain('*From:* John Doe <john@example.com>')
    expect(header.text.text).toContain('*MCM*')
    expect(header.text.text).toContain('*Subject:* Need help with order')
  })

  it('preview block is mrkdwn block-quoted', () => {
    const preview = buildSlackPayload(base).blocks[1] as {
      type: string
      text: { type: string; text: string }
    }
    expect(preview.type).toBe('section')
    expect(preview.text.type).toBe('mrkdwn')
    expect(preview.text.text.startsWith('> ')).toBe(true)
    expect(preview.text.text).toContain('order #1234')
  })

  it('action button URL points back at the portal conversation', () => {
    const action = buildSlackPayload(base).blocks[2] as {
      type: string
      elements: Array<{ type: string; text: { text: string }; url: string }>
    }
    expect(action.type).toBe('actions')
    expect(action.elements).toHaveLength(1)
    expect(action.elements[0].type).toBe('button')
    expect(action.elements[0].text.text).toBe('Open in Portal')
    expect(action.elements[0].url).toBe('https://portal.example/conversations/conv-abc')
  })

  it('omits Subject line when subject is null', () => {
    const header = buildSlackPayload({ ...base, subject: null }).blocks[0] as {
      text: { text: string }
    }
    expect(header.text.text).not.toContain('Subject:')
  })

  it('falls back to bare name when senderEmail is null', () => {
    const header = buildSlackPayload({ ...base, senderEmail: null }).blocks[0] as {
      text: { text: string }
    }
    expect(header.text.text).toContain('*From:* John Doe')
    expect(header.text.text).not.toContain('<')
  })
})

// ── sendSlackNotification ─────────────────────────────────────────────

describe('sendSlackNotification', () => {
  const payload = { text: 'hi', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }] }

  it('POSTs JSON to the webhook URL and returns true on 2xx', async () => {
    const ok = await sendSlackNotification('https://hooks.slack.com/services/T/B/X', payload, {
      account_id: 'acct-1',
    })
    expect(ok).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://hooks.slack.com/services/T/B/X')
    expect(fetchCalls[0].init?.method).toBe('POST')
    expect((fetchCalls[0].init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual(payload)
    expect(logInfo).toHaveBeenCalledWith(
      'notification',
      'slack_notification_sent',
      expect.any(String),
      expect.objectContaining({ account_id: 'acct-1' })
    )
  })

  it('returns false on non-2xx Slack response and logs slack_notification_failed', async () => {
    fetchImpl = async () => new Response('invalid_payload', { status: 400 })
    const ok = await sendSlackNotification('https://hooks.slack.com/services/T/B/X', payload)
    expect(ok).toBe(false)
    expect(logError).toHaveBeenCalledWith(
      'notification',
      'slack_notification_failed',
      expect.stringContaining('400'),
      expect.any(Object)
    )
  })

  it('returns false (does not throw) when fetch rejects', async () => {
    fetchImpl = async () => {
      throw new Error('ENOTFOUND')
    }
    const ok = await sendSlackNotification('https://hooks.slack.com/services/T/B/X', payload)
    expect(ok).toBe(false)
    expect(logError).toHaveBeenCalled()
  })

  it('returns false (does not throw) and logs timeout when fetch is aborted', async () => {
    // Simulate a slow Slack: never resolve until the AbortSignal fires.
    fetchImpl = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }
      })

    vi.useFakeTimers()
    const promise = sendSlackNotification('https://hooks.slack.com/services/T/B/X', payload)
    // Advance past the 5s SLACK_TIMEOUT_MS.
    await vi.advanceTimersByTimeAsync(5100)
    const ok = await promise
    vi.useRealTimers()

    expect(ok).toBe(false)
    expect(logError).toHaveBeenCalledWith(
      'notification',
      'slack_notification_failed',
      expect.stringContaining('timed out'),
      expect.objectContaining({ timeout: true })
    )
  })

  it('returns false immediately when webhookUrl is empty', async () => {
    const ok = await sendSlackNotification('', payload)
    expect(ok).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })
})

// ── triggerNotifications (Slack path) ────────────────────────────────

interface RuleRow {
  id: string
  account_id: string | null
  channel: string | null
  min_priority: string
  notify_email: boolean
  notify_in_portal: boolean
  notify_slack: boolean
  slack_webhook_url: string | null
  notify_email_address: string | null
  is_active: boolean
}

function fakeSupabase(rules: RuleRow[]): { from: (table: string) => unknown } {
  return {
    from: (table: string) => {
      if (table !== 'notification_rules') {
        return {
          select: () => ({ eq: async () => ({ data: [], error: null }) }),
        }
      }
      return {
        select: () => ({
          eq: async (_col: string, _v: unknown) => ({
            data: rules.filter((r) => r.is_active),
            error: null,
          }),
        }),
      }
    },
  }
}

function baseMessage(overrides: Partial<NotificationMessageData> = {}): NotificationMessageData {
  return {
    id: 'msg-1',
    conversation_id: 'conv-1',
    account_id: 'acct-1',
    account_name: 'MCM',
    channel: 'email',
    sender_name: 'John Doe',
    sender_email: 'john@example.com',
    email_subject: 'Need help',
    message_text: 'Hi, please help with my order.',
    is_spam: false,
    priority: 'medium',
    ...overrides,
  }
}

function slackRule(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: 'rule-1',
    account_id: null,
    channel: null,
    min_priority: 'low',
    notify_email: false,
    notify_in_portal: false,
    notify_slack: true,
    slack_webhook_url: 'https://hooks.slack.com/services/T/B/X',
    notify_email_address: null,
    is_active: true,
    ...overrides,
  }
}

describe('triggerNotifications (Slack path)', () => {
  it('skips Slack entirely when message is flagged spam', async () => {
    const supabase = fakeSupabase([slackRule()]) as never
    await triggerNotifications(supabase, baseMessage({ is_spam: true }))
    expect(fetchCalls).toHaveLength(0)
  })

  it('fires exactly one Slack POST when a matching rule is active', async () => {
    const supabase = fakeSupabase([slackRule()]) as never
    await triggerNotifications(supabase, baseMessage())
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://hooks.slack.com/services/T/B/X')
    const body = JSON.parse(String(fetchCalls[0].init?.body))
    expect(body.text).toContain('John Doe')
    expect(body.blocks).toHaveLength(3)
    // Action block button must point back at the portal conversation URL.
    const action = body.blocks[2]
    expect(action.elements[0].url).toBe('https://portal.example/conversations/conv-1')
  })

  it('skips when message priority is below rule min_priority', async () => {
    const supabase = fakeSupabase([slackRule({ min_priority: 'high' })]) as never
    // medium < high → no fetch
    await triggerNotifications(supabase, baseMessage({ priority: 'medium' }))
    expect(fetchCalls).toHaveLength(0)
  })

  it('honours min_priority when message meets or exceeds threshold', async () => {
    const supabase = fakeSupabase([slackRule({ min_priority: 'high' })]) as never
    await triggerNotifications(supabase, baseMessage({ priority: 'urgent' }))
    expect(fetchCalls).toHaveLength(1)
  })

  it('ignores rules where notify_slack is false', async () => {
    const supabase = fakeSupabase([slackRule({ notify_slack: false })]) as never
    await triggerNotifications(supabase, baseMessage())
    expect(fetchCalls).toHaveLength(0)
  })

  it('ignores rules with no slack_webhook_url even if notify_slack is true', async () => {
    const supabase = fakeSupabase([slackRule({ slack_webhook_url: null })]) as never
    await triggerNotifications(supabase, baseMessage())
    expect(fetchCalls).toHaveLength(0)
  })

  it('respects per-account rule scoping (different account → no fetch)', async () => {
    const supabase = fakeSupabase([slackRule({ account_id: 'other-acct' })]) as never
    await triggerNotifications(supabase, baseMessage({ account_id: 'acct-1' }))
    expect(fetchCalls).toHaveLength(0)
  })

  it('respects per-channel rule scoping (different channel → no fetch)', async () => {
    const supabase = fakeSupabase([slackRule({ channel: 'whatsapp' })]) as never
    await triggerNotifications(supabase, baseMessage({ channel: 'email' }))
    expect(fetchCalls).toHaveLength(0)
  })

  it('does not throw when Slack returns 500', async () => {
    fetchImpl = async () => new Response('boom', { status: 500 })
    const supabase = fakeSupabase([slackRule()]) as never
    await expect(triggerNotifications(supabase, baseMessage())).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalled()
  })

  it('fires both Slack rules independently when two are configured', async () => {
    const supabase = fakeSupabase([
      slackRule({ id: 'r1', slack_webhook_url: 'https://hooks.slack.com/services/A' }),
      slackRule({ id: 'r2', slack_webhook_url: 'https://hooks.slack.com/services/B' }),
    ]) as never
    await triggerNotifications(supabase, baseMessage())
    expect(fetchCalls.map((c) => c.url).sort()).toEqual([
      'https://hooks.slack.com/services/A',
      'https://hooks.slack.com/services/B',
    ])
  })
})
