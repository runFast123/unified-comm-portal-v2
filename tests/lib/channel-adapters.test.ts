import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the provider senders so the test asserts ONLY the adapter's routing +
// argument mapping — no real SMTP/Graph/Meta calls.
vi.mock('@/lib/channel-sender', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, provider_message_id: 'email-1' })),
  sendTeams: vi.fn(async () => ({ ok: true, provider_message_id: 'teams-1' })),
  sendWhatsApp: vi.fn(async () => ({ ok: true, provider_message_id: 'wa-1' })),
}))

import { sendViaChannel, getAdapter } from '@/lib/channels/adapters'
import { sendEmail, sendTeams, sendWhatsApp } from '@/lib/channel-sender'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('channel outbound adapters', () => {
  it('routes email to sendEmail with the mapped args', async () => {
    const res = await sendViaChannel('email', {
      accountId: 'acct-1',
      to: 'jane@example.com',
      body: 'Hello there',
      subject: 'Your order',
      replyToMessageId: '<msg-123@mail>',
      attachments: [{ path: 'acct-1/file.pdf', filename: 'file.pdf', contentType: 'application/pdf' }],
    })

    expect(res).toEqual({ ok: true, provider_message_id: 'email-1' })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendEmail).toHaveBeenCalledWith({
      accountId: 'acct-1',
      to: 'jane@example.com',
      subject: 'Your order',
      body: 'Hello there',
      replyToMessageId: '<msg-123@mail>',
      attachments: [{ path: 'acct-1/file.pdf', filename: 'file.pdf', contentType: 'application/pdf' }],
    })
    expect(sendTeams).not.toHaveBeenCalled()
    expect(sendWhatsApp).not.toHaveBeenCalled()
  })

  it('applies the "Re: Your inquiry" subject default for email when none is given', async () => {
    await sendViaChannel('email', { accountId: null, to: 'x@y.com', body: 'no subject here' })
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Re: Your inquiry' })
    )
  })

  it('routes teams to sendTeams, mapping `to` -> chatId and ignoring email-only fields', async () => {
    const res = await sendViaChannel('teams', {
      accountId: 'acct-2',
      to: '19:chat-abc@thread.v2',
      body: 'team message',
      // these email-only fields must be ignored by the teams adapter:
      subject: 'ignored',
      replyToMessageId: 'ignored',
    })

    expect(res).toEqual({ ok: true, provider_message_id: 'teams-1' })
    expect(sendTeams).toHaveBeenCalledTimes(1)
    expect(sendTeams).toHaveBeenCalledWith({
      accountId: 'acct-2',
      chatId: '19:chat-abc@thread.v2',
      body: 'team message',
    })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('routes whatsapp to sendWhatsApp, mapping `to` -> toPhone', async () => {
    const res = await sendViaChannel('whatsapp', {
      accountId: 'acct-3',
      to: '+15551234567',
      body: 'wa message',
    })

    expect(res).toEqual({ ok: true, provider_message_id: 'wa-1' })
    expect(sendWhatsApp).toHaveBeenCalledTimes(1)
    expect(sendWhatsApp).toHaveBeenCalledWith({
      accountId: 'acct-3',
      toPhone: '+15551234567',
      body: 'wa message',
    })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(sendTeams).not.toHaveBeenCalled()
  })

  it('returns a failed SendResult for an unknown channel and calls no sender', async () => {
    const res = await sendViaChannel('telegram', { accountId: 'a', to: 'x', body: 'y' })
    expect(res).toEqual({ ok: false, error: 'Unsupported channel: telegram' })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(sendTeams).not.toHaveBeenCalled()
    expect(sendWhatsApp).not.toHaveBeenCalled()
  })

  it('getAdapter resolves known channels and rejects unknown / null', () => {
    expect(getAdapter('email')).not.toBeNull()
    expect(getAdapter('teams')).not.toBeNull()
    expect(getAdapter('whatsapp')).not.toBeNull()
    expect(getAdapter('telegram')).toBeNull()
    expect(getAdapter(null)).toBeNull()
    expect(getAdapter(undefined)).toBeNull()
  })
})
