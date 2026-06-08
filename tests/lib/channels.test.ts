import { describe, it, expect } from 'vitest'
import { CHANNELS, CHANNEL_KEYS, CHANNEL_LIST, getChannel, resolveRecipient, isChannel } from '@/lib/channels/registry'
import { getChannelLabel, getChannelColor, getChannelBgColor } from '@/lib/utils'

describe('channel registry', () => {
  it('registers the known channels with complete descriptors', () => {
    expect([...CHANNEL_KEYS].sort()).toEqual(['email', 'instagram', 'livechat', 'messenger', 'sms', 'teams', 'telegram', 'whatsapp'])
    expect(CHANNEL_LIST.length).toBe(CHANNEL_KEYS.length)
    for (const c of CHANNEL_LIST) {
      expect(CHANNELS[c.key]).toBe(c) // key matches its map slot
      expect(c.label).toBeTruthy()
      expect(c.filterLabel).toMatch(/ Only$/)
      expect(c.hex).toMatch(/^#[0-9a-f]{6}$/i)
      expect(c.textClass).toContain(c.hex)
      expect(c.bgClass).toContain(c.hex)
      expect(c.capabilities).toMatchObject({
        inbound: expect.any(Boolean),
        outbound: expect.any(Boolean),
        attachments: expect.any(Boolean),
        threading: expect.any(Boolean),
      })
    }
  })

  it('getChannel tolerates unknown / null keys', () => {
    expect(getChannel('email')?.label).toBe('Email')
    expect(getChannel('whatsapp')?.label).toBe('WhatsApp')
    expect(getChannel('sms')?.label).toBe('SMS')
    expect(getChannel('telegram')?.label).toBe('Telegram')
    expect(getChannel('messenger')?.label).toBe('Messenger')
    expect(getChannel('instagram')?.label).toBe('Instagram')
    expect(getChannel('discord')).toBeNull()
    expect(getChannel('constructor')).toBeNull() // prototype member, not a channel
    expect(getChannel(null)).toBeNull()
    expect(getChannel(undefined)).toBeNull()
  })

  // Regression guard: the refactored utils helpers must return the EXACT same
  // values the old hardcoded switches did, for all three channels.
  it('utils channel helpers preserve the prior label/colour values', () => {
    expect(getChannelLabel('teams')).toBe('Teams')
    expect(getChannelLabel('email')).toBe('Email')
    expect(getChannelLabel('whatsapp')).toBe('WhatsApp')

    expect(getChannelColor('teams')).toBe('text-[#6264a7]')
    expect(getChannelColor('email')).toBe('text-[#ea4335]')
    expect(getChannelColor('whatsapp')).toBe('text-[#25d366]')

    expect(getChannelBgColor('teams')).toBe('bg-[#6264a7]')
    expect(getChannelBgColor('email')).toBe('bg-[#ea4335]')
    expect(getChannelBgColor('whatsapp')).toBe('bg-[#25d366]')

    expect(getChannelLabel('sms')).toBe('SMS')
    expect(getChannelColor('sms')).toBe('text-[#f22f46]')
    expect(getChannelBgColor('sms')).toBe('bg-[#f22f46]')

    expect(getChannelLabel('telegram')).toBe('Telegram')
    expect(getChannelColor('telegram')).toBe('text-[#0088cc]')
    expect(getChannelBgColor('telegram')).toBe('bg-[#0088cc]')

    expect(getChannelLabel('messenger')).toBe('Messenger')
    expect(getChannelColor('messenger')).toBe('text-[#0084ff]')
    expect(getChannelBgColor('messenger')).toBe('bg-[#0084ff]')

    expect(getChannelLabel('instagram')).toBe('Instagram')
    expect(getChannelColor('instagram')).toBe('text-[#e4405f]')
    expect(getChannelBgColor('instagram')).toBe('bg-[#e4405f]')
  })

  it('resolveRecipient maps each channel to its recipient field', () => {
    const src = { participant_email: 'a@b.com', teams_chat_id: '19:chat', participant_phone: '+15551234567' }
    expect(resolveRecipient('email', src)).toBe('a@b.com')
    expect(resolveRecipient('teams', src)).toBe('19:chat')
    expect(resolveRecipient('whatsapp', src)).toBe('+15551234567')
    expect(resolveRecipient('sms', src)).toBe('+15551234567') // SMS reuses participant_phone
    expect(resolveRecipient('telegram', src)).toBe('19:chat') // Telegram reuses teams_chat_id
    expect(resolveRecipient('messenger', src)).toBe('19:chat') // Messenger reuses teams_chat_id (PSID)
    expect(resolveRecipient('instagram', src)).toBe('19:chat') // Instagram reuses teams_chat_id (IGSID)
    expect(resolveRecipient('unknown', src)).toBeNull()
    expect(resolveRecipient('email', {})).toBeNull() // missing field -> null
  })

  it('isChannel accepts only registered channels and is prototype-safe', () => {
    for (const k of CHANNEL_KEYS) expect(isChannel(k)).toBe(true)
    expect(isChannel('discord')).toBe(false)
    expect(isChannel(null)).toBe(false)
    expect(isChannel(undefined)).toBe(false)
    expect(isChannel('')).toBe(false)
    // inherited Object.prototype members must NOT pass (hasOwnProperty guard)
    expect(isChannel('constructor')).toBe(false)
    expect(isChannel('toString')).toBe(false)
    expect(isChannel('hasOwnProperty')).toBe(false)
    expect(isChannel('__proto__')).toBe(false)
  })
})
