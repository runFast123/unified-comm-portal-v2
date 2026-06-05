import { describe, it, expect } from 'vitest'
import { CHANNELS, CHANNEL_KEYS, CHANNEL_LIST, getChannel } from '@/lib/channels/registry'
import { getChannelLabel, getChannelColor, getChannelBgColor } from '@/lib/utils'

describe('channel registry', () => {
  it('registers the known channels with complete descriptors', () => {
    expect([...CHANNEL_KEYS].sort()).toEqual(['email', 'teams', 'whatsapp'])
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
    expect(getChannel('telegram')).toBeNull()
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
  })
})
