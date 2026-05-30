import { describe, it, expect } from 'vitest'
import { decodeHtmlEntities } from '@/lib/utils'

describe('decodeHtmlEntities', () => {
  it('decodes hex, decimal, and named apostrophe + ampersand entities', () => {
    // The exact leak the audit caught in newsletter previews.
    expect(decodeHtmlEntities('Don&#x27;t &amp; won&#39;t')).toBe("Don't & won't")
  })

  it('decodes the standard named entities', () => {
    expect(decodeHtmlEntities('a &lt;b&gt; &quot;c&quot;')).toBe('a <b> "c"')
  })

  it('leaves no raw numeric entity code in the output (&#160;)', () => {
    const out = decodeHtmlEntities('hello&#160;world')
    expect(out).not.toContain('&#160;')
    // \s matches a regular space OR the decoded NBSP — normalise before compare.
    expect(out.replace(/\s/g, ' ')).toBe('hello world')
  })

  it('decodes &nbsp; to a regular space', () => {
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b')
  })

  it('returns an empty string for null / undefined / empty', () => {
    expect(decodeHtmlEntities(null)).toBe('')
    expect(decodeHtmlEntities(undefined)).toBe('')
    expect(decodeHtmlEntities('')).toBe('')
  })

  it('leaves plain text untouched', () => {
    expect(decodeHtmlEntities('just plain text 123')).toBe('just plain text 123')
  })

  it('ignores malformed / out-of-range code points safely', () => {
    // Should not throw; invalid code points decode to '' rather than crashing.
    expect(() => decodeHtmlEntities('bad &#x110000; code')).not.toThrow()
  })
})
