// Tests for normalizeApiKey (src/lib/ai-providers.ts).
//
// It guards the two silent paste mistakes that produce a 401 on an otherwise
// valid key — both confirmed against NVIDIA:
//   - a leading "Bearer " (the provider's docs show the full Authorization
//     header, so it's natural to copy it) -> we add "Bearer" ourselves ->
//     `Bearer Bearer <key>` -> 401.
//   - surrounding whitespace / a trailing newline from copying a line.

import { describe, it, expect } from 'vitest'
import { normalizeApiKey } from '@/lib/ai-providers'

describe('normalizeApiKey', () => {
  it('leaves a clean key untouched', () => {
    expect(normalizeApiKey('nvapi-abc123')).toBe('nvapi-abc123')
  })

  it('strips a leading "Bearer " (the 401 cause)', () => {
    expect(normalizeApiKey('Bearer nvapi-abc123')).toBe('nvapi-abc123')
  })

  it('strips "Bearer" case-insensitively and with extra spaces', () => {
    expect(normalizeApiKey('bearer   nvapi-abc123')).toBe('nvapi-abc123')
    expect(normalizeApiKey('BEARER nvapi-abc123')).toBe('nvapi-abc123')
  })

  it('trims surrounding whitespace and newlines', () => {
    expect(normalizeApiKey('  nvapi-abc123  ')).toBe('nvapi-abc123')
    expect(normalizeApiKey('nvapi-abc123\n')).toBe('nvapi-abc123')
    expect(normalizeApiKey('\tnvapi-abc123\r\n')).toBe('nvapi-abc123')
  })

  it('handles "Bearer " with surrounding whitespace together', () => {
    expect(normalizeApiKey('  Bearer nvapi-abc123\n')).toBe('nvapi-abc123')
  })

  it('does NOT strip "Bearer" when it is part of the key, not a prefix', () => {
    // Only a leading "Bearer " followed by whitespace is a prefix; a key that
    // merely contains the letters is left alone.
    expect(normalizeApiKey('nvapi-Bearer-xyz')).toBe('nvapi-Bearer-xyz')
  })

  it('returns empty string for null/undefined/blank', () => {
    expect(normalizeApiKey(null)).toBe('')
    expect(normalizeApiKey(undefined)).toBe('')
    expect(normalizeApiKey('   ')).toBe('')
  })
})
