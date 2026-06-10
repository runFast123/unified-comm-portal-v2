import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { verifyMetaSignature, whatsappEnvelopeToRelay, metaMessagingEnvelopeToRelay } from '@/lib/channels/meta-native'

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

describe('whatsappEnvelopeToRelay', () => {
  it('parses a text-message envelope', () => {
    const env = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'PNID' },
        contacts: [{ profile: { name: 'John' }, wa_id: '14155550000' }],
        messages: [{ from: '14155550000', id: 'wamid.X', timestamp: '1700000000', type: 'text', text: { body: 'Hello' } }],
      } }] }],
    }
    const r = whatsappEnvelopeToRelay(env, 'acct-1')
    expect(r).toMatchObject({ account_id: 'acct-1', sender_phone: '14155550000', text: 'Hello', message_type: 'text' })
    expect(r?.timestamp).toBe(new Date(1700000000 * 1000).toISOString())
  })

  it('handles button + interactive replies', () => {
    expect(whatsappEnvelopeToRelay({ entry: [{ changes: [{ value: { messages: [{ from: 'p', type: 'button', button: { text: 'Yes' } }] } }] }] }, 'a')?.text).toBe('Yes')
    expect(whatsappEnvelopeToRelay({ entry: [{ changes: [{ value: { messages: [{ from: 'p', type: 'interactive', interactive: { button_reply: { title: 'Opt A' } } }] } }] }] }, 'a')?.text).toBe('Opt A')
  })

  it('returns null for status / non-message events (ack + ignore)', () => {
    expect(whatsappEnvelopeToRelay({ entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] }, 'a')).toBeNull()
    expect(whatsappEnvelopeToRelay({ entry: [] }, 'a')).toBeNull()
    expect(whatsappEnvelopeToRelay({}, 'a')).toBeNull()
    expect(whatsappEnvelopeToRelay(null, 'a')).toBeNull()
  })
})

describe('metaMessagingEnvelopeToRelay (Messenger + Instagram)', () => {
  it('parses a messaging envelope (ms timestamp)', () => {
    const env = { object: 'page', entry: [{ id: 'PAGE', messaging: [{ sender: { id: 'PSID1' }, recipient: { id: 'PAGE' }, timestamp: 1700000000000, message: { mid: 'm_1', text: 'Hi there' } }] }] }
    const r = metaMessagingEnvelopeToRelay(env, 'acct-9')
    expect(r).toMatchObject({ account_id: 'acct-9', sender_id: 'PSID1', text: 'Hi there', message_id: 'm_1' })
    expect(r?.timestamp).toBe(new Date(1700000000000).toISOString())
  })

  it('ignores echoes, delivery/read events, attachment-only + empty', () => {
    expect(metaMessagingEnvelopeToRelay({ entry: [{ messaging: [{ sender: { id: 'p' }, message: { mid: 'm', text: 'x', is_echo: true } }] }] }, 'a')).toBeNull()
    expect(metaMessagingEnvelopeToRelay({ entry: [{ messaging: [{ sender: { id: 'p' }, delivery: { mids: ['m'] } }] }] }, 'a')).toBeNull()
    expect(metaMessagingEnvelopeToRelay({ entry: [{ messaging: [{ sender: { id: 'p' }, message: { mid: 'm', attachments: [{}] } }] }] }, 'a')).toBeNull()
    expect(metaMessagingEnvelopeToRelay({ entry: [] }, 'a')).toBeNull()
    expect(metaMessagingEnvelopeToRelay(null, 'a')).toBeNull()
  })
})
