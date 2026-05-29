import { describe, it, expect } from 'vitest'
import { computeThreadRoot, normalizeMessageId } from '@/lib/email-threading'
import { normalizeEmailSubject } from '@/lib/api-helpers'

describe('computeThreadRoot', () => {
  it('prefers the Gmail threadId over everything else', () => {
    expect(
      computeThreadRoot({
        gmailThreadId: '18c0abc',
        references: '<a@x.com> <b@x.com>',
        inReplyTo: '<b@x.com>',
        messageId: '<c@x.com>',
      }),
    ).toBe('gmail:18c0abc')
  })

  it('uses the FIRST id in a space-separated References string (the thread originator)', () => {
    expect(
      computeThreadRoot({
        references: '<root@x.com> <reply1@x.com> <reply2@x.com>',
        inReplyTo: '<reply2@x.com>',
        messageId: '<reply3@x.com>',
      }),
    ).toBe('root@x.com')
  })

  it('uses the FIRST entry when References is an array', () => {
    expect(
      computeThreadRoot({
        references: ['<root@x.com>', '<reply1@x.com>'],
        messageId: '<reply2@x.com>',
      }),
    ).toBe('root@x.com')
  })

  it('falls back to In-Reply-To when References is absent', () => {
    expect(
      computeThreadRoot({
        references: null,
        inReplyTo: '<parent@x.com>',
        messageId: '<self@x.com>',
      }),
    ).toBe('parent@x.com')
  })

  it('falls back to own Message-ID for a brand-new thread (no refs / no in-reply-to)', () => {
    expect(
      computeThreadRoot({
        references: null,
        inReplyTo: null,
        messageId: '<self@x.com>',
      }),
    ).toBe('self@x.com')
  })

  it('strips angle brackets and surrounding whitespace', () => {
    expect(
      computeThreadRoot({ messageId: '   <  abc@x.com  >  ' }),
    ).toBe('abc@x.com')
  })

  it('returns null when there is genuinely nothing to key off', () => {
    expect(
      computeThreadRoot({ references: '   ', inReplyTo: '', messageId: null }),
    ).toBeNull()
  })

  it('skips empty reference tokens and uses the first non-empty one', () => {
    expect(
      computeThreadRoot({ references: '   <root@x.com>   ' }),
    ).toBe('root@x.com')
  })
})

describe('normalizeMessageId', () => {
  it('strips brackets/whitespace, returns null for empty', () => {
    expect(normalizeMessageId('<m@x.com>')).toBe('m@x.com')
    expect(normalizeMessageId('   ')).toBeNull()
    expect(normalizeMessageId(null)).toBeNull()
    expect(normalizeMessageId(undefined)).toBeNull()
  })
})

describe('normalizeEmailSubject', () => {
  it('strips a single Re: prefix and lowercases', () => {
    expect(normalizeEmailSubject('Re: Order #123')).toBe('order #123')
  })

  it('strips stacked reply/forward prefixes (Re: Fwd: ...)', () => {
    expect(normalizeEmailSubject('Re: Fwd: Quarterly Report')).toBe('quarterly report')
  })

  it('handles localized prefixes (AW:) and collapses whitespace', () => {
    expect(normalizeEmailSubject('AW:   Spaced    Out')).toBe('spaced out')
  })

  it('returns null for empty / prefix-only subjects', () => {
    expect(normalizeEmailSubject('')).toBeNull()
    expect(normalizeEmailSubject(null)).toBeNull()
    expect(normalizeEmailSubject('Re:')).toBeNull()
  })
})
