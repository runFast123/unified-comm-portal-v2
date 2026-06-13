/**
 * Tests for the system-alert path in src/lib/notification-service.ts.
 *
 * Coverage:
 *   - shouldAlertChannelDisconnect → fires exactly on the threshold-crossing
 *     transition (4 → 5), not before, and not on repeat failures (5 → 6).
 *   - buildSystemAlertSlackPayload → Block Kit shape (text + 3 blocks, action
 *     button URL).
 *   - sendSystemAlert → emails every active company admin via SMTP, posts to
 *     Slack rule webhooks scoped to the alerted account (deduped; unscoped and
 *     other-account rules are dropped as a cross-tenant disclosure guard),
 *     prefixes portal paths, and NEVER throws (fail-soft contract for
 *     cron/poller callers).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Logger mock — silences logInfo/logError and lets us assert calls.
const logInfo = vi.fn()
const logError = vi.fn()
vi.mock('@/lib/logger', () => ({
  logInfo: (...args: unknown[]) => logInfo(...args),
  logError: (...args: unknown[]) => logError(...args),
}))

// nodemailer mock — capture sendMail calls so we can assert recipients.
const sendMail = vi.fn(async (..._args: unknown[]) => ({ messageId: 'stub' }))
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: (...args: unknown[]) => sendMail(...args),
    }),
  },
}))

import {
  sendSystemAlert,
  shouldAlertChannelDisconnect,
  buildSystemAlertSlackPayload,
  type SystemAlert,
} from '@/lib/notification-service'

interface FetchCall {
  url: string
  init?: RequestInit
}

const fetchCalls: FetchCall[] = []

beforeEach(() => {
  fetchCalls.length = 0
  logInfo.mockReset()
  logError.mockReset()
  sendMail.mockClear()
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    fetchCalls.push({ url, init })
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASSWORD
  process.env.NEXT_PUBLIC_SITE_URL = 'https://portal.example'
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── shouldAlertChannelDisconnect ──────────────────────────────────────

describe('shouldAlertChannelDisconnect', () => {
  const T = 5

  it('fires exactly when the counter crosses the threshold (4 → 5)', () => {
    expect(shouldAlertChannelDisconnect(4, 5, T)).toBe(true)
  })

  it('does not fire below the threshold (3 → 4)', () => {
    expect(shouldAlertChannelDisconnect(3, 4, T)).toBe(false)
  })

  it('does not fire on the first failure (0 → 1)', () => {
    expect(shouldAlertChannelDisconnect(0, 1, T)).toBe(false)
  })

  it('does not re-fire once the breaker is already open (5 → 6, half-open retry)', () => {
    expect(shouldAlertChannelDisconnect(5, 6, T)).toBe(false)
    expect(shouldAlertChannelDisconnect(9, 10, T)).toBe(false)
  })

  it('fires when a jump crosses the threshold in one step (4 → 7)', () => {
    expect(shouldAlertChannelDisconnect(4, 7, T)).toBe(true)
  })
})

// ── buildSystemAlertSlackPayload ──────────────────────────────────────

describe('buildSystemAlertSlackPayload', () => {
  const payload = buildSystemAlertSlackPayload({
    title: 'Channel disconnected: Support Inbox (email)',
    body: 'Polling failed 5 times in a row.',
    link: 'https://portal.example/admin/channels',
  })

  it('uses the title as fallback text and produces 3 blocks', () => {
    expect(payload.text).toBe('Channel disconnected: Support Inbox (email)')
    expect(payload.blocks).toHaveLength(3)
  })

  it('puts the body in the second mrkdwn section', () => {
    const body = payload.blocks[1] as { type: string; text: { type: string; text: string } }
    expect(body.type).toBe('section')
    expect(body.text.type).toBe('mrkdwn')
    expect(body.text.text).toContain('failed 5 times')
  })

  it('action button URL points at the link', () => {
    const action = payload.blocks[2] as {
      type: string
      elements: Array<{ type: string; url: string }>
    }
    expect(action.type).toBe('actions')
    expect(action.elements[0].url).toBe('https://portal.example/admin/channels')
  })
})

// ── sendSystemAlert ───────────────────────────────────────────────────

interface FakeOpts {
  companyId?: string | null
  admins?: Array<{ email: string | null }>
  rules?: Array<Record<string, unknown>>
}

/**
 * Minimal thenable query-builder fake: every chained filter returns itself,
 * `await chain` resolves to the table's rows, `.maybeSingle()` resolves the
 * accounts row. Mirrors only what sendSystemAlert touches.
 */
function fakeSupabase(opts: FakeOpts): never {
  return {
    from: (table: string) => {
      const rows: unknown =
        table === 'users'
          ? opts.admins ?? []
          : table === 'notification_rules'
            ? opts.rules ?? []
            : []
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.in = () => chain
      chain.maybeSingle = async () => ({
        data: table === 'accounts' ? { company_id: opts.companyId ?? null } : null,
        error: null,
      })
      chain.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
        resolve({ data: rows, error: null })
      return chain
    },
  } as never
}

function baseAlert(overrides: Partial<SystemAlert> = {}): SystemAlert {
  return {
    account_id: 'acct-1',
    company_id: 'co-1',
    type: 'channel_disconnected',
    title: 'Channel disconnected: Support Inbox (email)',
    body: 'Polling failed 5 times in a row.',
    link: '/admin/channels',
    ...overrides,
  }
}

function slackRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rule-1',
    // Default to baseAlert()'s account so the rule DELIVERS by default. Tests
    // that exercise tenant scoping override account_id — setting it to null
    // models an unscoped/other-tenant rule, which must now be dropped.
    account_id: 'acct-1',
    notify_slack: true,
    slack_webhook_url: 'https://hooks.slack.com/services/T/B/X',
    is_active: true,
    ...overrides,
  }
}

describe('sendSystemAlert', () => {
  it('emails every active company admin when SMTP is configured', async () => {
    process.env.SMTP_USER = 'portal@example.com'
    process.env.SMTP_PASSWORD = 'secret'
    const supabase = fakeSupabase({
      admins: [{ email: 'admin1@example.com' }, { email: 'admin2@example.com' }],
    })
    await sendSystemAlert(supabase, baseAlert())
    expect(sendMail).toHaveBeenCalledTimes(2)
    const recipients = sendMail.mock.calls.map(
      (c) => (c as unknown[])[0] as { to: string; subject: string }
    )
    expect(recipients.map((r) => r.to).sort()).toEqual([
      'admin1@example.com',
      'admin2@example.com',
    ])
    expect(recipients[0].subject).toContain('[System Alert]')
  })

  it('dedupes admin emails case-insensitively', async () => {
    process.env.SMTP_USER = 'portal@example.com'
    process.env.SMTP_PASSWORD = 'secret'
    const supabase = fakeSupabase({
      admins: [{ email: 'Admin@Example.com' }, { email: 'admin@example.com' }, { email: null }],
    })
    await sendSystemAlert(supabase, baseAlert())
    expect(sendMail).toHaveBeenCalledTimes(1)
  })

  it('skips email silently when SMTP env is missing but still posts Slack', async () => {
    const supabase = fakeSupabase({
      admins: [{ email: 'admin1@example.com' }],
      rules: [slackRule()],
    })
    await sendSystemAlert(supabase, baseAlert())
    expect(sendMail).not.toHaveBeenCalled()
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://hooks.slack.com/services/T/B/X')
  })

  it('posts only to rules scoped to the alerted account, dropping unscoped + other-account rules and deduping URLs', async () => {
    const supabase = fakeSupabase({
      rules: [
        // unscoped (account_id = null) → DROPPED: no owning company (see filter)
        slackRule({ id: 'r1', account_id: null, slack_webhook_url: 'https://hooks.slack.com/services/A' }),
        // scoped to the alerted account → DELIVERED
        slackRule({ id: 'r2', account_id: 'acct-1', slack_webhook_url: 'https://hooks.slack.com/services/B' }),
        // scoped to a different account → DROPPED
        slackRule({ id: 'r3', account_id: 'other-acct', slack_webhook_url: 'https://hooks.slack.com/services/C' }),
        // duplicate URL of r2, also account-scoped → collapses into one POST
        slackRule({ id: 'r4', account_id: 'acct-1', slack_webhook_url: 'https://hooks.slack.com/services/B' }),
        // account matches but notify_slack off → DROPPED
        slackRule({ id: 'r5', account_id: 'acct-1', notify_slack: false, slack_webhook_url: 'https://hooks.slack.com/services/D' }),
      ],
    })
    await sendSystemAlert(supabase, baseAlert())
    expect(fetchCalls.map((c) => c.url)).toEqual(['https://hooks.slack.com/services/B'])
  })

  it('does NOT deliver to an unscoped rule that may belong to a different company (cross-tenant guard)', async () => {
    // An unscoped rule (account_id = NULL) cannot be attributed to any company
    // — notification_rules has no company_id column, only account_id. Such a
    // rule may have been created by, or be visible to, a DIFFERENT tenant, so
    // an alert about acct-1 (company co-1) must never POST to it. An
    // other-company account-scoped rule must likewise be dropped.
    const supabase = fakeSupabase({
      rules: [
        slackRule({
          id: 'global',
          account_id: null,
          slack_webhook_url: 'https://hooks.slack.com/services/OTHER-TENANT',
        }),
        slackRule({
          id: 'other-co',
          account_id: 'acct-in-co-2',
          slack_webhook_url: 'https://hooks.slack.com/services/CO2',
        }),
      ],
    })
    await sendSystemAlert(supabase, baseAlert({ account_id: 'acct-1', company_id: 'co-1' }))
    expect(fetchCalls).toHaveLength(0)
    // And the summary log must reflect zero Slack deliveries.
    expect(logInfo).toHaveBeenCalledWith(
      'notification',
      'system_alert_sent',
      expect.any(String),
      expect.objectContaining({ slack_webhooks: 0 }),
    )
  })

  it('prefixes portal paths with NEXT_PUBLIC_SITE_URL in the Slack button', async () => {
    const supabase = fakeSupabase({ rules: [slackRule()] })
    await sendSystemAlert(supabase, baseAlert({ link: '/admin/channels' }))
    const body = JSON.parse(String(fetchCalls[0].init?.body))
    const action = body.blocks[2]
    expect(action.elements[0].url).toBe('https://portal.example/admin/channels')
  })

  it('resolves company_id from the accounts table when not provided', async () => {
    process.env.SMTP_USER = 'portal@example.com'
    process.env.SMTP_PASSWORD = 'secret'
    const supabase = fakeSupabase({
      companyId: 'co-9',
      admins: [{ email: 'admin@example.com' }],
    })
    await sendSystemAlert(supabase, baseAlert({ company_id: undefined }))
    expect(sendMail).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith(
      'notification',
      'system_alert_sent',
      expect.any(String),
      expect.objectContaining({ company_id: 'co-9' })
    )
  })

  it('never throws — even when the Supabase client itself blows up', async () => {
    const supabase = {
      from: () => {
        throw new Error('boom')
      },
    } as never
    await expect(sendSystemAlert(supabase, baseAlert())).resolves.toBeUndefined()
  })

  it('never throws when Slack returns 500', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: input.toString(), init })
      return new Response('boom', { status: 500 })
    }) as unknown as typeof fetch
    const supabase = fakeSupabase({ rules: [slackRule()] })
    await expect(sendSystemAlert(supabase, baseAlert())).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalled()
  })
})
