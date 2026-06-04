import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { parseJsonBody } from '@/lib/validation'

function jsonReq(body: string): Request {
  return new Request('http://test.local/api', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  })
}

const Schema = z.object({
  account_id: z.string().min(1),
  count: z.number().int().optional(),
})

describe('parseJsonBody', () => {
  it('returns typed data on a valid body', async () => {
    const r = await parseJsonBody(jsonReq(JSON.stringify({ account_id: 'a1', count: 3 })), Schema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({ account_id: 'a1', count: 3 })
  })

  it('rejects malformed JSON with 400', async () => {
    const r = await parseJsonBody(jsonReq('{ not json'), Schema)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.response.status).toBe(400)
      expect((await r.response.json()).error).toMatch(/Invalid JSON/i)
    }
  })

  it('rejects a schema violation with 400 naming the bad field', async () => {
    const r = await parseJsonBody(jsonReq(JSON.stringify({ count: 'nope' })), Schema)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.response.status).toBe(400)
      expect((await r.response.json()).error).toMatch(/account_id/)
    }
  })

  it('strips unknown keys by default (no rejection)', async () => {
    const r = await parseJsonBody(jsonReq(JSON.stringify({ account_id: 'a1', extra: 'x' })), Schema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({ account_id: 'a1' })
  })
})
