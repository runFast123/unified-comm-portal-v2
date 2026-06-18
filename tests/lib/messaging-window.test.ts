import { describe, it, expect } from 'vitest'
import { computeReplyWindow, formatReplyWindow } from '@/lib/messaging-window'

const HOUR = 3_600_000
const NOW = 1_700_000_000_000

describe('computeReplyWindow', () => {
  it('is not applicable for non-Meta channels', () => {
    for (const ch of ['email', 'teams', 'sms', 'telegram', 'livechat']) {
      expect(computeReplyWindow(ch, new Date(NOW).toISOString(), NOW)).toEqual({
        applicable: false,
        open: false,
        hoursLeft: null,
      })
    }
  })

  it('is open within 24h, with hoursLeft counting down', () => {
    const w = computeReplyWindow('whatsapp', new Date(NOW - 6 * HOUR).toISOString(), NOW)
    expect(w.applicable).toBe(true)
    expect(w.open).toBe(true)
    expect(Math.round(w.hoursLeft!)).toBe(18)
  })

  it('is closed at/after 24h', () => {
    const w = computeReplyWindow('messenger', new Date(NOW - 25 * HOUR).toISOString(), NOW)
    expect(w.applicable).toBe(true)
    expect(w.open).toBe(false)
    expect(w.hoursLeft).toBe(0)
  })

  it('is closed (window applicable) when there is no inbound message', () => {
    expect(computeReplyWindow('instagram', null, NOW)).toEqual({
      applicable: true,
      open: false,
      hoursLeft: 0,
    })
  })

  it('fails safe to closed on an unparseable timestamp', () => {
    expect(computeReplyWindow('whatsapp', 'not-a-date', NOW).open).toBe(false)
  })
})

describe('formatReplyWindow', () => {
  it('formats each state', () => {
    expect(formatReplyWindow({ applicable: false, open: false, hoursLeft: null })).toBe('')
    expect(formatReplyWindow({ applicable: true, open: false, hoursLeft: 0 })).toBe('Reply window closed')
    expect(formatReplyWindow({ applicable: true, open: true, hoursLeft: 6.5 })).toBe('6h left to reply')
    expect(formatReplyWindow({ applicable: true, open: true, hoursLeft: 0.5 })).toBe('<1h left to reply')
  })
})
