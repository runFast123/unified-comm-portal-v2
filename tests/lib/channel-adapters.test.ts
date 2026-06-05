import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the provider senders so the test asserts ONLY the adapter's routing +
// argument mapping — no real SMTP/Graph/Meta calls.
vi.mock('@/lib/channel-sender', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, provider_message_id: 'email-1' })),
  sendTeams: vi.fn(async () => ({ ok: true, provider_message_id: 'teams-1' })),
  sendWhatsApp: vi.fn(async () => ({ ok: true, provider_message_id: 'wa-1' })),
  verifyEmailConfig: vi.fn(async () => ({ ok: true })),
  verifyTeamsConfig: vi.fn(async () => ({ ok: true })),
  verifyWhatsAppConfig: vi.fn(async () => ({ ok: true })),
  sendSms: vi.fn(async () => ({ ok: true, provider_message_id: 'sms-1' })),
  verifySmsConfig: vi.fn(async () => ({ ok: true })),
  sendTelegram: vi.fn(async () => ({ ok: true, provider_message_id: 'tg-1' })),
  verifyTelegramConfig: vi.fn(async () => ({ ok: true })),
  sendMessenger: vi.fn(async () => ({ ok: true, provider_message_id: 'fb-1' })),
  verifyMessengerConfig: vi.fn(async () => ({ ok: true })),
  sendInstagram: vi.fn(async () => ({ ok: true, provider_message_id: 'ig-1' })),
  verifyInstagramConfig: vi.fn(async () => ({ ok: true })),
}))

import { sendViaChannel, getAdapter } from '@/lib/channels/adapters'
import {
  sendEmail,
  sendTeams,
  sendWhatsApp,
  sendSms,
  sendTelegram,
  sendMessenger,
  sendInstagram,
  verifyEmailConfig,
  verifyTeamsConfig,
  verifyWhatsAppConfig,
  verifySmsConfig,
  verifyTelegramConfig,
  verifyMessengerConfig,
  verifyInstagramConfig,
} from '@/lib/channel-sender'

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
    const res = await sendViaChannel('discord', { accountId: 'a', to: 'x', body: 'y' })
    expect(res).toEqual({ ok: false, error: 'Unsupported channel: discord' })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(sendTeams).not.toHaveBeenCalled()
    expect(sendWhatsApp).not.toHaveBeenCalled()
  })

  it('getAdapter resolves known channels and rejects unknown / null', () => {
    expect(getAdapter('email')).not.toBeNull()
    expect(getAdapter('teams')).not.toBeNull()
    expect(getAdapter('whatsapp')).not.toBeNull()
    expect(getAdapter('telegram')).not.toBeNull()
    expect(getAdapter('messenger')).not.toBeNull()
    expect(getAdapter('instagram')).not.toBeNull()
    expect(getAdapter('discord')).toBeNull()
    expect(getAdapter('constructor')).toBeNull() // prototype member, not a channel
    expect(getAdapter(null)).toBeNull()
    expect(getAdapter(undefined)).toBeNull()
  })

  it('routes verifyConfig to the matching provider verify fn', async () => {
    const emailCfg = { smtp_host: 'h', smtp_user: 'u', smtp_password: 'p' }
    expect(await getAdapter('email')!.verifyConfig(emailCfg)).toEqual({ ok: true })
    expect(verifyEmailConfig).toHaveBeenCalledWith(emailCfg)

    const teamsCfg = { azure_tenant_id: 't' }
    await getAdapter('teams')!.verifyConfig(teamsCfg)
    expect(verifyTeamsConfig).toHaveBeenCalledWith(teamsCfg)

    const waCfg = { phone_number_id: 'p', access_token: 't' }
    await getAdapter('whatsapp')!.verifyConfig(waCfg)
    expect(verifyWhatsAppConfig).toHaveBeenCalledWith(waCfg)

    // each verify fn used exactly once, no cross-routing
    expect(verifyEmailConfig).toHaveBeenCalledTimes(1)
    expect(verifyTeamsConfig).toHaveBeenCalledTimes(1)
    expect(verifyWhatsAppConfig).toHaveBeenCalledTimes(1)
  })

  it('routes sms to sendSms (to -> toPhone) and verifyConfig to verifySmsConfig', async () => {
    const res = await sendViaChannel('sms', { accountId: 'acct-4', to: '+15557654321', body: 'sms message' })
    expect(res).toEqual({ ok: true, provider_message_id: 'sms-1' })
    expect(sendSms).toHaveBeenCalledWith({ accountId: 'acct-4', toPhone: '+15557654321', body: 'sms message' })

    const smsCfg = { account_sid: 'AC1', auth_token: 't', from_number: '+1' }
    await getAdapter('sms')!.verifyConfig(smsCfg)
    expect(verifySmsConfig).toHaveBeenCalledWith(smsCfg)
  })

  it('routes telegram to sendTelegram (to -> chatId) and verifyConfig to verifyTelegramConfig', async () => {
    const res = await sendViaChannel('telegram', { accountId: 'acct-5', to: '987654321', body: 'tg message' })
    expect(res).toEqual({ ok: true, provider_message_id: 'tg-1' })
    expect(sendTelegram).toHaveBeenCalledWith({ accountId: 'acct-5', chatId: '987654321', body: 'tg message' })

    const tgCfg = { bot_token: '123:ABC' }
    await getAdapter('telegram')!.verifyConfig(tgCfg)
    expect(verifyTelegramConfig).toHaveBeenCalledWith(tgCfg)
  })

  it('routes messenger to sendMessenger (to -> recipientId) and verifyConfig to verifyMessengerConfig', async () => {
    const res = await sendViaChannel('messenger', { accountId: 'acct-6', to: 'psid-123', body: 'fb message' })
    expect(res).toEqual({ ok: true, provider_message_id: 'fb-1' })
    expect(sendMessenger).toHaveBeenCalledWith({ accountId: 'acct-6', recipientId: 'psid-123', body: 'fb message' })

    const fbCfg = { page_id: '111', page_access_token: 'tok' }
    await getAdapter('messenger')!.verifyConfig(fbCfg)
    expect(verifyMessengerConfig).toHaveBeenCalledWith(fbCfg)
  })

  it('routes instagram to sendInstagram (to -> recipientId) and verifyConfig to verifyInstagramConfig', async () => {
    const res = await sendViaChannel('instagram', { accountId: 'acct-7', to: 'igsid-456', body: 'ig message' })
    expect(res).toEqual({ ok: true, provider_message_id: 'ig-1' })
    expect(sendInstagram).toHaveBeenCalledWith({ accountId: 'acct-7', recipientId: 'igsid-456', body: 'ig message' })

    const igCfg = { page_id: '222', page_access_token: 'tok2' }
    await getAdapter('instagram')!.verifyConfig(igCfg)
    expect(verifyInstagramConfig).toHaveBeenCalledWith(igCfg)
  })
})
