import { describe, it, expect } from 'vitest'
import { telegramUpdateToRelay } from '@/lib/channels/telegram-native'

describe('telegramUpdateToRelay (native Telegram inbound)', () => {
  it('parses a native text-message Update into the relay shape', () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 42,
        from: { id: 7, first_name: 'John', last_name: 'Doe', username: 'jdoe' },
        chat: { id: 7, type: 'private' },
        date: 1700000000,
        text: 'Hello there',
      },
    }
    const r = telegramUpdateToRelay(update, 'acct-1')
    expect(r).toMatchObject({ account_id: 'acct-1', chat_id: 7, sender_name: 'John Doe', text: 'Hello there', message_id: 42 })
    expect(r?.timestamp).toBe(new Date(1700000000 * 1000).toISOString())
  })

  it('falls back to username, then chat title, for the sender name', () => {
    expect(telegramUpdateToRelay({ message: { message_id: 1, chat: { id: 1 }, from: { username: 'jdoe' }, text: 'hi' } }, 'a')?.sender_name).toBe('jdoe')
    expect(telegramUpdateToRelay({ message: { message_id: 1, chat: { id: 1, title: 'Group' }, from: {}, text: 'hi' } }, 'a')?.sender_name).toBe('Group')
  })

  it('uses caption when there is no text', () => {
    expect(telegramUpdateToRelay({ message: { message_id: 1, chat: { id: 1 }, caption: 'photo caption' } }, 'a')?.text).toBe('photo caption')
  })

  it('handles edited_message and channel_post', () => {
    expect(telegramUpdateToRelay({ edited_message: { message_id: 2, chat: { id: 1 }, text: 'edited' } }, 'a')?.text).toBe('edited')
    expect(telegramUpdateToRelay({ channel_post: { message_id: 3, chat: { id: 1 }, text: 'post' } }, 'a')?.text).toBe('post')
  })

  it('returns null for non-message / non-text updates (ack + ignore)', () => {
    expect(telegramUpdateToRelay({ update_id: 1 }, 'a')).toBeNull()
    expect(telegramUpdateToRelay({ my_chat_member: {} }, 'a')).toBeNull()
    expect(telegramUpdateToRelay({ message: { message_id: 1, chat: { id: 1 }, text: '   ' } }, 'a')).toBeNull()
    expect(telegramUpdateToRelay({ message: { message_id: 1 } }, 'a')).toBeNull()
    expect(telegramUpdateToRelay(null, 'a')).toBeNull()
    expect(telegramUpdateToRelay('nope', 'a')).toBeNull()
  })
})
