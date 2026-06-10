import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { verifyTwilioSignature, twilioFormToRelay } from '@/lib/channels/twilio-native'

function sign(u: string, p: Record<string, string>, tok: string): string {
  let data = u
  for (const k of Object.keys(p).sort()) data += k + p[k]
  return crypto.createHmac('sha1', tok).update(Buffer.from(data, 'utf-8')).digest('base64')
}

describe('verifyTwilioSignature', () => {
  const token = 'twilio-auth-token'
  const url = 'https://app.example.com/api/webhooks/sms?account=acct-1'
  const params = { From: '+14155550000', To: '+14155551111', Body: 'Hello', MessageSid: 'SM123' }

  it('accepts a valid signature', () => {
    expect(verifyTwilioSignature(url, params, sign(url, params, token), token)).toBe(true)
  })

  it('rejects wrong token / tampered params / wrong url / missing inputs', () => {
    const good = sign(url, params, token)
    expect(verifyTwilioSignature(url, params, good, 'wrong-token')).toBe(false)
    expect(verifyTwilioSignature(url, { ...params, Body: 'Tampered' }, good, token)).toBe(false)
    expect(verifyTwilioSignature('https://evil.example.com/x', params, good, token)).toBe(false)
    expect(verifyTwilioSignature(url, params, null, token)).toBe(false)
    expect(verifyTwilioSignature(url, params, good, '')).toBe(false)
  })
})

describe('twilioFormToRelay', () => {
  it('maps Twilio form params to the relay shape', () => {
    const r = twilioFormToRelay({ From: '+14155550000', Body: 'Hi', MessageSid: 'SM1' }, 'acct-1')
    expect(r).toEqual({ account_id: 'acct-1', sender_phone: '+14155550000', text: 'Hi', message_sid: 'SM1' })
  })

  it('falls back to SmsSid, and returns null for body-less callbacks', () => {
    expect(twilioFormToRelay({ From: '+1', Body: 'x', SmsSid: 'SS1' }, 'a')?.message_sid).toBe('SS1')
    expect(twilioFormToRelay({ From: '+1', MessageStatus: 'delivered' }, 'a')).toBeNull()
    expect(twilioFormToRelay({ From: '+1', Body: '   ' }, 'a')).toBeNull()
  })
})
