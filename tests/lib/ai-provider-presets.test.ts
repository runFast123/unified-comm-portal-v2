// Tests for the AI provider preset catalog (src/lib/ai-providers.ts).
//
// The invariant that matters most: a preset base_url must NOT end in a slash.
// Every call site builds `${base_url}/chat/completions`, so a stored trailing
// slash yields `…//chat/completions`. That used to be worse than it sounds —
// the two "Test connection" endpoints strip the slash but callChat did not, so
// a provider could pass its connection test and then 404 on every real call.
// Google's own Gemini docs show the base URL WITH a trailing slash, which is
// exactly how someone would introduce it.

import { describe, it, expect } from 'vitest'
import { AI_PROVIDER_PRESETS, getPreset } from '@/lib/ai-providers'

describe('AI provider presets', () => {
  it('no preset base_url ends in a slash (would produce a double slash)', () => {
    for (const p of AI_PROVIDER_PRESETS) {
      expect(p.base_url, `${p.key} base_url must not end with "/"`).not.toMatch(/\/$/)
    }
  })

  it('every preset with a base_url uses https', () => {
    for (const p of AI_PROVIDER_PRESETS) {
      if (!p.base_url) continue // `custom` is intentionally blank
      expect(p.base_url, `${p.key} must be https`).toMatch(/^https:\/\//)
    }
  })

  it('preset keys are unique', () => {
    const keys = AI_PROVIDER_PRESETS.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every preset has a non-empty label', () => {
    for (const p of AI_PROVIDER_PRESETS) {
      expect(p.label.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('Google Gemini preset', () => {
  const gemini = getPreset('gemini')

  it('is registered so it appears in the provider dropdown', () => {
    expect(gemini).toBeTruthy()
    expect(gemini!.label).toBe('Google Gemini')
  })

  it('points at the OpenAI-compatibility layer, without a trailing slash', () => {
    // Google documents `https://generativelanguage.googleapis.com/v1beta/openai/`
    // — we deliberately store it without the trailing slash.
    expect(gemini!.base_url).toBe('https://generativelanguage.googleapis.com/v1beta/openai')
  })

  it('builds a valid chat-completions URL (no double slash)', () => {
    const url = `${gemini!.base_url}/chat/completions`
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    expect(url).not.toContain('//chat')
  })

  it('suggests current stable text models', () => {
    expect(gemini!.models.length).toBeGreaterThan(0)
    expect(gemini!.models).toContain('gemini-3.6-flash')
    // Suggestions must be text/chat models — not image/video/embedding ones.
    for (const m of gemini!.models) {
      expect(m).not.toMatch(/image|video|veo|embedding/i)
    }
  })

  it('has a docs link and an API-key hint for the setup form', () => {
    expect(gemini!.docsUrl).toContain('ai.google.dev')
    expect(gemini!.apiKeyHint).toBeTruthy()
  })
})
