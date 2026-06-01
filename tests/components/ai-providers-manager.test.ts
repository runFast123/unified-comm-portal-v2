import { describe, it, expect } from 'vitest'
import { formatMaskedKey } from '@/components/dashboard/ai-providers-manager'

describe('formatMaskedKey', () => {
  it('prefers the server-provided masked string when present', () => {
    expect(formatMaskedKey(true, 'nvapi-…f3a2')).toBe('nvapi-…f3a2')
  })

  it('trims surrounding whitespace from the masked string', () => {
    expect(formatMaskedKey(true, '  sk-…9abc  ')).toBe('sk-…9abc')
  })

  it('falls back to a generic mask when a key exists but no masked string is given', () => {
    expect(formatMaskedKey(true, null)).toBe('••••••••')
    expect(formatMaskedKey(true, undefined)).toBe('••••••••')
    expect(formatMaskedKey(true, '')).toBe('••••••••')
    expect(formatMaskedKey(true, '   ')).toBe('••••••••')
  })

  it('reports no key when none is stored', () => {
    expect(formatMaskedKey(false, null)).toBe('No API key')
    expect(formatMaskedKey(false, undefined)).toBe('No API key')
    expect(formatMaskedKey(false, '')).toBe('No API key')
  })

  it('shows the masked string even if has_api_key is somehow false (display-only is source of truth)', () => {
    // Defensive: if the API returns a masked value, surface it regardless of
    // the boolean flag rather than misleadingly claiming there is no key.
    expect(formatMaskedKey(false, 'sk-…1234')).toBe('sk-…1234')
  })
})
