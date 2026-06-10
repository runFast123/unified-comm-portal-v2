import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { verifyMetaSignature, whatsappEnvelopeToRelays, metaMessagingEnvelopeToRelays } from '@/lib/channels/meta-native'

describe('verifyMetaSignature (Meta X-Hub-Signature-256)', () => {
  const secret = 'app-secret-123'
  const body = JSON.stringify({ hello: 'world' })
  const goodSig = 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')

  it('accepts a correct signature', () => {
    expect(verifyMetaSignature(body, goodSig, secret)).toBe(true)
  })

  it('rejects wrong signature / wrong secret / tampered body / missing inputs', () => {
    expect(verifyMetaSignature(body, 'sha256=deadbeef', secret)).toBe(false)
    expect(verifyMetaSignature(body, goodSig, 'wrong-secret')).toBe(false)
    expect(verifyMetaSignature('tampered', goodSig, secret)).toBe(false)
    expect(verifyMetaSignature(body, null, secret)).toBe(false)
    expect(verifyMetaSignature(body, goodSig, '')).toBe(false)
  })
})

function waEnvelope(messages: unknown[], phoneNumberId = 'PNID') {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, messages } }] }],
  }
}

describe('whatsappEnvelopeToRelays', () => {
  it('parses a text-message envelope', () => {
    const env = waEnvelope([
      { from: '14155550000', id: 'wamid.X', timestamp: '1700000000', type: 'text', text: { body: 'Hello' } },
    ])
    const r = whatsappEnvelopeToRelays(env, 'acct-1')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ account_id: 'acct-1', sender_phone: '14155550000', text: 'Hello', message_type: 'text' })
    expect(r[0].timestamp).toBe(new Date(1700000000 * 1000).toISOString())
  })

  it('handles button + interactive replies', () => {
    expect(whatsappEnvelopeToRelays(waEnvelope([{ from: 'p', type: 'button', button: { text: 'Yes' } }]), 'a')[0]?.text).toBe('Yes')
    expect(whatsappEnvelopeToRelays(waEnvelope([{ from: 'p', type: 'interactive', interactive: { button_reply: { title: 'Opt A' } } }]), 'a')[0]?.text).toBe('Opt A')
  })

  it('keeps caption-less media as a placeholder (never 400s back to Meta)', () => {
    const r = whatsappEnvelopeToRelays(waEnvelope([
      { from: 'p', type: 'image', image: { id: 'media-1' } },
      { from: 'p', type: 'audio', audio: { id: 'media-2' } },
      { from: 'p', type: 'image', image: { id: 'media-3', caption: 'see attached' } },
    ]), 'a')
    expect(r.map((x) => x.text)).toEqual(['[image]', '[audio]', 'see attached'])
  })

  it('skips reactions and unknown types', () => {
    expect(whatsappEnvelopeToRelays(waEnvelope([{ from: 'p', type: 'reaction', reaction: { emoji: '👍' } }]), 'a')).toEqual([])
  })

  it('processes EVERY message in a batched delivery (multi entry × changes × messages)', () => {
    const env = {
      entry: [
        { changes: [{ value: { metadata: { phone_number_id: 'PNID' }, messages: [
          { from: 'p1', type: 'text', text: { body: 'one' } },
          { from: 'p2', type: 'text', text: { body: 'two' } },
        ] } }] },
        { changes: [{ value: { metadata: { phone_number_id: 'PNID' }, messages: [
          { from: 'p3', type: 'text', text: { body: 'three' } },
        ] } }] },
      ],
    }
    expect(whatsappEnvelopeToRelays(env, 'a').map((r) => r.text)).toEqual(['one', 'two', 'three'])
  })

  it('filters deliveries for OTHER phone numbers when expectedPhoneNumberId is given', () => {
    const env = {
      entry: [
        { changes: [{ value: { metadata: { phone_number_id: 'MINE' }, messages: [{ from: 'p', type: 'text', text: { body: 'mine' } }] } }] },
        { changes: [{ value: { metadata: { phone_number_id: 'OTHER' }, messages: [{ from: 'p', type: 'text', text: { body: 'not mine' } }] } }] },
      ],
    }
    expect(whatsappEnvelopeToRelays(env, 'a', 'MINE').map((r) => r.text)).toEqual(['mine'])
    // Without the hint, everything passes (single-number setups).
    expect(whatsappEnvelopeToRelays(env, 'a')).toHaveLength(2)
  })

  it('returns [] for status / non-message events (ack + ignore)', () => {
    expect(whatsappEnvelopeToRelays({ entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] }, 'a')).toEqual([])
    expect(whatsappEnvelopeToRelays({ entry: [] }, 'a')).toEqual([])
    expect(whatsappEnvelopeToRelays({}, 'a')).toEqual([])
    expect(whatsappEnvelopeToRelays(null, 'a')).toEqual([])
  })
})

describe('metaMessagingEnvelopeToRelays (Messenger + Instagram)', () => {
  it('parses a messaging envelope (ms timestamp)', () => {
    const env = { object: 'page', entry: [{ id: 'PAGE', messaging: [{ sender: { id: 'PSID1' }, recipient: { id: 'PAGE' }, timestamp: 1700000000000, message: { mid: 'm_1', text: 'Hi there' } }] }] }
    const r = metaMessagingEnvelopeToRelays(env, 'acct-9')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ account_id: 'acct-9', sender_id: 'PSID1', text: 'Hi there', message_id: 'm_1' })
    expect(r[0].timestamp).toBe(new Date(1700000000000).toISOString())
  })

  it('processes EVERY message in a batched delivery', () => {
    const env = { entry: [
      { id: 'PAGE', messaging: [
        { sender: { id: 'p1' }, message: { mid: 'm1', text: 'one' } },
        { sender: { id: 'p2' }, message: { mid: 'm2', text: 'two' } },
      ] },
      { id: 'PAGE', messaging: [{ sender: { id: 'p3' }, message: { mid: 'm3', text: 'three' } }] },
    ] }
    expect(metaMessagingEnvelopeToRelays(env, 'a').map((r) => r.text)).toEqual(['one', 'two', 'three'])
  })

  it('filters entries for OTHER pages when expectedPageId is given (Messenger)', () => {
    const env = { entry: [
      { id: 'MY_PAGE', messaging: [{ sender: { id: 'p' }, message: { mid: 'm1', text: 'mine' } }] },
      { id: 'OTHER_PAGE', messaging: [{ sender: { id: 'p' }, message: { mid: 'm2', text: 'not mine' } }] },
    ] }
    expect(metaMessagingEnvelopeToRelays(env, 'a', 'MY_PAGE').map((r) => r.text)).toEqual(['mine'])
    expect(metaMessagingEnvelopeToRelays(env, 'a')).toHaveLength(2)
  })

  it('ignores echoes, delivery/read events, attachment-only + empty', () => {
    expect(metaMessagingEnvelopeToRelays({ entry: [{ messaging: [{ sender: { id: 'p' }, message: { mid: 'm', text: 'x', is_echo: true } }] }] }, 'a')).toEqual([])
    expect(metaMessagingEnvelopeToRelays({ entry: [{ messaging: [{ sender: { id: 'p' }, delivery: { mids: ['m'] } }] }] }, 'a')).toEqual([])
    expect(metaMessagingEnvelopeToRelays({ entry: [{ messaging: [{ sender: { id: 'p' }, message: { mid: 'm', attachments: [{}] } }] }] }, 'a')).toEqual([])
    expect(metaMessagingEnvelopeToRelays({ entry: [] }, 'a')).toEqual([])
    expect(metaMessagingEnvelopeToRelays(null, 'a')).toEqual([])
  })
})
