import { describe, it, expect } from 'vitest'
import { parseWhatsAppInbound, MAX_MESSAGE_LENGTH } from '@/lib/channels/inbound'

describe('parseWhatsAppInbound', () => {
  it('normalizes a plain text message', () => {
    const m = parseWhatsAppInbound({
      account_id: 'acct-1',
      sender_phone: '+15551234567',
      text: 'hello there',
      message_type: 'text',
      timestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(m).toEqual({
      channel: 'whatsapp',
      account_id: 'acct-1',
      message_text: 'hello there',
      message_type: 'text',
      timestamp: '2026-01-01T00:00:00.000Z',
      sender_name: '+15551234567',
      sender_email: null,
      sender_phone: '+15551234567',
      sender_type: 'customer',
      direction: 'inbound',
      replied: false,
      reply_required: true,
      teams_chat_id: null,
      teams_message_id: null,
      whatsapp_media_url: null,
      attachments: null,
    })
  })

  it('uses a [Media: type] placeholder when text is empty but media is present', () => {
    const m = parseWhatsAppInbound({ sender_phone: '+1', media_url: 'https://cdn/x.jpg', message_type: 'image' })
    expect(m.message_text).toBe('[Media: image]')
    expect(m.message_type).toBe('attachment')
    expect(m.whatsapp_media_url).toBe('https://cdn/x.jpg')
  })

  it('defaults the media placeholder type to "attachment" when message_type is absent', () => {
    const m = parseWhatsAppInbound({ media_url: 'https://cdn/x' })
    expect(m.message_text).toBe('[Media: attachment]')
    expect(m.message_type).toBe('attachment')
  })

  it('non-text message_type maps to "attachment"', () => {
    const m = parseWhatsAppInbound({ text: 'caption', message_type: 'document' })
    expect(m.message_type).toBe('attachment')
    expect(m.message_text).toBe('caption')
  })

  it('truncates an over-length body to 50KB + marker', () => {
    const m = parseWhatsAppInbound({ text: 'a'.repeat(MAX_MESSAGE_LENGTH + 1) })
    expect(m.message_text.length).toBe(MAX_MESSAGE_LENGTH + '... [truncated]'.length)
    expect(m.message_text.endsWith('... [truncated]')).toBe(true)
  })

  it('tolerates a fully empty payload (webhook handles the 400s)', () => {
    const m = parseWhatsAppInbound({})
    expect(m.account_id).toBeNull()
    expect(m.sender_phone).toBeNull()
    expect(m.sender_name).toBeNull()
    expect(m.message_text).toBe('')
    expect(m.timestamp).toBeNull()
    expect(m.sender_type).toBe('customer')
    expect(m.direction).toBe('inbound')
  })
})
