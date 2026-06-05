import { describe, it, expect } from 'vitest'
import { parseWhatsAppInbound, parseTeamsInbound, MAX_MESSAGE_LENGTH } from '@/lib/channels/inbound'

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

describe('parseTeamsInbound', () => {
  it('normalizes a customer message (message -> text, file attachments kept)', () => {
    const m = parseTeamsInbound({
      account_id: 'acct-1',
      sender_name: 'Jane Doe',
      sender_email: 'jane@example.com',
      message_text: 'hello team',
      teams_message_id: 'tm-1',
      teams_chat_id: '19:chat-abc@thread.v2',
      message_type: 'message',
      timestamp: '2026-01-01T00:00:00.000Z',
      attachments: [{ name: 'f.pdf' }],
    })
    expect(m).toEqual({
      channel: 'teams',
      account_id: 'acct-1',
      message_text: 'hello team',
      message_type: 'text',
      timestamp: '2026-01-01T00:00:00.000Z',
      sender_name: 'Jane Doe',
      sender_email: 'jane@example.com',
      sender_phone: null,
      sender_type: 'customer',
      direction: 'inbound',
      replied: false,
      reply_required: true,
      teams_chat_id: '19:chat-abc@thread.v2',
      teams_message_id: 'tm-1',
      whatsapp_media_url: null,
      attachments: [{ name: 'f.pdf' }],
    })
  })

  it('flips role fields for an agent message (boolean true)', () => {
    const m = parseTeamsInbound({ message_text: 'agent reply', is_agent_message: true })
    expect(m.sender_type).toBe('agent')
    expect(m.direction).toBe('outbound')
    expect(m.replied).toBe(true)
    expect(m.reply_required).toBe(false)
  })

  it('treats the string "true" as an agent message too', () => {
    const m = parseTeamsInbound({ message_text: 'x', is_agent_message: 'true' })
    expect(m.sender_type).toBe('agent')
    expect(m.direction).toBe('outbound')
  })

  it('maps message_type: undefined -> text, image stays image', () => {
    expect(parseTeamsInbound({ message_text: 'a' }).message_type).toBe('text')
    expect(parseTeamsInbound({ message_text: 'a', message_type: 'image' }).message_type).toBe('image')
  })

  it('drops empty / non-array attachments to null', () => {
    expect(parseTeamsInbound({ message_text: 'a', attachments: [] }).attachments).toBeNull()
    expect(parseTeamsInbound({ message_text: 'a', attachments: 'nope' }).attachments).toBeNull()
    expect(parseTeamsInbound({ message_text: 'a' }).attachments).toBeNull()
  })

  it('truncates an over-length body to 50KB + marker', () => {
    const m = parseTeamsInbound({ message_text: 'b'.repeat(MAX_MESSAGE_LENGTH + 100) })
    expect(m.message_text.length).toBe(MAX_MESSAGE_LENGTH + '... [truncated]'.length)
    expect(m.message_text.endsWith('... [truncated]')).toBe(true)
  })
})
