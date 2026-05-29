import { describe, it, expect } from 'vitest'
import { getReplyToMessageId } from '@/lib/api-helpers'

// Minimal Supabase stub for the single chain the helper builds:
//   from('messages').select().eq().eq().eq().not().order().limit().maybeSingle()
// `terminal` is either the resolved row payload or a thrower (to prove the
// helper swallows DB errors and degrades to null rather than blocking a send).
function clientReturning(terminal: { data: unknown } | (() => never)) {
  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    not: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => (typeof terminal === 'function' ? terminal() : terminal),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: () => chain } as any
}

describe('getReplyToMessageId', () => {
  it('returns the latest inbound email Message-ID when one exists', async () => {
    const client = clientReturning({ data: { email_message_id: '<abc123@mail.example.com>' } })
    expect(await getReplyToMessageId(client, 'conv-1')).toBe('<abc123@mail.example.com>')
  })

  it('returns null when no inbound email carries a Message-ID', async () => {
    const client = clientReturning({ data: null })
    expect(await getReplyToMessageId(client, 'conv-1')).toBeNull()
  })

  it('returns null when the matched row has a null email_message_id', async () => {
    const client = clientReturning({ data: { email_message_id: null } })
    expect(await getReplyToMessageId(client, 'conv-1')).toBeNull()
  })

  it('never throws — degrades to null when the query errors', async () => {
    const client = clientReturning(() => {
      throw new Error('db unavailable')
    })
    await expect(getReplyToMessageId(client, 'conv-1')).resolves.toBeNull()
  })
})
