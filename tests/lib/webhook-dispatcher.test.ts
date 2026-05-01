// Tests for src/lib/webhook-dispatcher.ts
//
// Coverage:
//   - signPayload returns sha256=<hex> matching crypto.createHmac
//   - dispatchToSubscription succeeds on the first 2xx, records one
//     delivery row, and clears consecutive_failures.
//   - dispatchToSubscription retries on 5xx and records every attempt,
//     succeeds on the final retry, and resets the failure counter.
//   - After 5 failed dispatches, the subscription is auto-deactivated.
//   - HMAC signature appears in the X-Webhook-Signature header on every
//     attempt and matches the body sent.

import crypto from 'crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Module mocks --------------------------------------------------

interface SubRow {
  id: string
  is_active: boolean
  consecutive_failures: number
  last_delivery_at: string | null
}

const fixture = {
  subs: new Map<string, SubRow>(),
  deliveries: [] as Array<Record<string, unknown>>,
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(async () => ({
    from: (table: string) => {
      const filters: Array<{ col: string; value: unknown }> = []
      let mode: 'select' | 'insert' | 'update' = 'select'
      let updatePayload: Record<string, unknown> | null = null
      let insertPayload: Record<string, unknown> | null = null

      const exec = async () => {
        if (table === 'webhook_deliveries' && mode === 'insert') {
          fixture.deliveries.push(insertPayload as Record<string, unknown>)
          return { data: null, error: null }
        }
        if (table === 'webhook_subscriptions' && mode === 'update') {
          const idEq = filters.find((f) => f.col === 'id')
          if (!idEq) return { data: null, error: null }
          const sub = fixture.subs.get(String(idEq.value))
          if (sub && updatePayload) {
            for (const [k, v] of Object.entries(updatePayload)) {
              ;(sub as unknown as Record<string, unknown>)[k] = v
            }
          }
          return { data: null, error: null }
        }
        return { data: null, error: null }
      }

      const chain: Record<string, unknown> = {
        select: () => {
          mode = 'select'
          return chain
        },
        insert: (payload: Record<string, unknown>) => {
          mode = 'insert'
          insertPayload = payload
          return Promise.resolve(exec())
        },
        update: (payload: Record<string, unknown>) => {
          mode = 'update'
          updatePayload = payload
          return chain
        },
        eq: (col: string, value: unknown) => {
          filters.push({ col, value })
          return chain
        },
        then: (resolve: (v: unknown) => unknown) => exec().then(resolve),
      }
      return chain
    },
  })),
}))

vi.mock('@/lib/logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

// ---- Imports AFTER mocks -------------------------------------------

import { signPayload, __test } from '@/lib/webhook-dispatcher'

const { dispatchToSubscription, RETRY_DELAYS_MS, DEACTIVATE_AFTER_FAILURES } = __test

beforeEach(() => {
  fixture.subs.clear()
  fixture.deliveries.length = 0
})

// Sleep stub: instant. Tests would otherwise wait 36s for full retries.
const noSleep = () => Promise.resolve()

describe('signPayload', () => {
  it('returns sha256=<hex> matching createHmac', () => {
    const body = '{"hello":"world"}'
    const secret = 'top-secret'
    const expected =
      'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
    expect(signPayload(body, secret)).toBe(expected)
  })

  it('different bodies produce different signatures', () => {
    expect(signPayload('a', 's')).not.toBe(signPayload('b', 's'))
  })
})

describe('dispatchToSubscription — success', () => {
  it('succeeds on first attempt, records one delivery, clears failures', async () => {
    fixture.subs.set('sub-1', {
      id: 'sub-1',
      is_active: true,
      consecutive_failures: 3, // pretend it had been failing
      last_delivery_at: null,
    })

    const fetchImpl = vi.fn(async () =>
      new Response('ok', { status: 200 }),
    ) as unknown as typeof fetch

    await dispatchToSubscription(
      {
        id: 'sub-1',
        company_id: 'comp-a',
        url: 'https://example.com/webhook',
        events: ['conversation.created'],
        signing_secret: 'topsecret',
        is_active: true,
        consecutive_failures: 3,
      },
      'conversation.created',
      { conversation_id: 'c1' },
      { fetchImpl, sleepImpl: noSleep },
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fixture.deliveries.length).toBe(1)
    expect(fixture.deliveries[0].http_status).toBe(200)
    expect(fixture.deliveries[0].retry_count).toBe(0)

    const sub = fixture.subs.get('sub-1')!
    expect(sub.consecutive_failures).toBe(0)
    expect(sub.last_delivery_at).not.toBeNull()
  })

  it('sends the HMAC signature header matching the body', async () => {
    fixture.subs.set('sub-2', {
      id: 'sub-2',
      is_active: true,
      consecutive_failures: 0,
      last_delivery_at: null,
    })

    let capturedHeaders: Record<string, string> = {}
    let capturedBody = ''
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      capturedBody = String(init?.body ?? '')
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    await dispatchToSubscription(
      {
        id: 'sub-2',
        company_id: 'comp-a',
        url: 'https://example.com/wh',
        events: ['message.received'],
        signing_secret: 'shh',
        is_active: true,
        consecutive_failures: 0,
      },
      'message.received',
      { hello: 'world' },
      { fetchImpl, sleepImpl: noSleep },
    )

    expect(capturedHeaders['X-Webhook-Signature']).toBe(signPayload(capturedBody, 'shh'))
    expect(capturedHeaders['X-Webhook-Event']).toBe('message.received')
    expect(capturedBody).toContain('"event":"message.received"')
    expect(capturedBody).toContain('"hello":"world"')
  })
})

describe('dispatchToSubscription — failure + retry', () => {
  it('retries on 5xx and records every attempt; succeeds on the final retry', async () => {
    fixture.subs.set('sub-3', {
      id: 'sub-3',
      is_active: true,
      consecutive_failures: 0,
      last_delivery_at: null,
    })

    let call = 0
    const fetchImpl = vi.fn(async () => {
      call++
      // First two attempts 503, third 200.
      return new Response('', { status: call < 3 ? 503 : 200 })
    }) as unknown as typeof fetch

    await dispatchToSubscription(
      {
        id: 'sub-3',
        company_id: 'comp-a',
        url: 'https://example.com/wh',
        events: ['conversation.created'],
        signing_secret: 'k',
        is_active: true,
        consecutive_failures: 0,
      },
      'conversation.created',
      {},
      { fetchImpl, sleepImpl: noSleep },
    )

    // 1 initial + 2 retries before success (3 total attempts → indexes 0,1,2)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fixture.deliveries.length).toBe(3)
    // The retry_count column should track 0, 1, 2
    expect(fixture.deliveries.map((d) => d.retry_count)).toEqual([0, 1, 2])
    expect(fixture.deliveries[2].http_status).toBe(200)

    const sub = fixture.subs.get('sub-3')!
    expect(sub.consecutive_failures).toBe(0)
  })

  it('exhausts all retries on persistent 500 and increments consecutive_failures', async () => {
    fixture.subs.set('sub-4', {
      id: 'sub-4',
      is_active: true,
      consecutive_failures: 0,
      last_delivery_at: null,
    })

    const fetchImpl = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch

    await dispatchToSubscription(
      {
        id: 'sub-4',
        company_id: 'comp-a',
        url: 'https://example.com/wh',
        events: ['conversation.created'],
        signing_secret: 'k',
        is_active: true,
        consecutive_failures: 0,
      },
      'conversation.created',
      {},
      { fetchImpl, sleepImpl: noSleep },
    )

    // 1 initial + RETRY_DELAYS_MS.length retries
    expect(fetchImpl).toHaveBeenCalledTimes(1 + RETRY_DELAYS_MS.length)
    expect(fixture.deliveries.length).toBe(1 + RETRY_DELAYS_MS.length)

    const sub = fixture.subs.get('sub-4')!
    expect(sub.consecutive_failures).toBe(1)
    expect(sub.is_active).toBe(true) // not yet at threshold
  })

  it('deactivates the subscription after DEACTIVATE_AFTER_FAILURES consecutive failures', async () => {
    fixture.subs.set('sub-5', {
      id: 'sub-5',
      is_active: true,
      consecutive_failures: DEACTIVATE_AFTER_FAILURES - 1,
      last_delivery_at: null,
    })

    const fetchImpl = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch

    await dispatchToSubscription(
      {
        id: 'sub-5',
        company_id: 'comp-a',
        url: 'https://example.com/wh',
        events: ['conversation.created'],
        signing_secret: 'k',
        is_active: true,
        consecutive_failures: DEACTIVATE_AFTER_FAILURES - 1,
      },
      'conversation.created',
      {},
      { fetchImpl, sleepImpl: noSleep },
    )

    const sub = fixture.subs.get('sub-5')!
    expect(sub.consecutive_failures).toBe(DEACTIVATE_AFTER_FAILURES)
    expect(sub.is_active).toBe(false)
  })

  it('records "error" with no http_status when fetch throws', async () => {
    fixture.subs.set('sub-6', {
      id: 'sub-6',
      is_active: true,
      consecutive_failures: 0,
      last_delivery_at: null,
    })

    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch

    await dispatchToSubscription(
      {
        id: 'sub-6',
        company_id: 'comp-a',
        url: 'https://nope.example/wh',
        events: ['conversation.created'],
        signing_secret: 'k',
        is_active: true,
        consecutive_failures: 0,
      },
      'conversation.created',
      {},
      { fetchImpl, sleepImpl: noSleep },
    )

    expect(fixture.deliveries.length).toBe(1 + RETRY_DELAYS_MS.length)
    for (const d of fixture.deliveries) {
      expect(d.http_status).toBeNull()
      expect(d.error).toContain('ECONNREFUSED')
    }
  })
})
