import { describe, it, expect } from 'vitest'
import { validateProviderBaseUrl } from '@/lib/ssrf'

describe('validateProviderBaseUrl (SSRF guard for AI provider URLs)', () => {
  it('allows public HTTPS endpoints', () => {
    expect(validateProviderBaseUrl('https://api.openai.com/v1')).toBeNull()
    expect(validateProviderBaseUrl('https://integrate.api.nvidia.com/v1')).toBeNull()
    expect(validateProviderBaseUrl('https://openrouter.ai/api/v1')).toBeNull()
  })

  it('rejects non-HTTPS', () => {
    expect(validateProviderBaseUrl('http://api.openai.com/v1')).toMatch(/HTTPS/)
  })

  it('rejects loopback / private / link-local ranges', () => {
    for (const u of [
      'https://localhost/v1',
      'https://127.0.0.1/v1',
      'https://10.0.0.5/v1',
      'https://192.168.1.10/v1',
      'https://172.16.0.1/v1',
      'https://169.254.169.254/latest/meta-data', // AWS metadata IP
    ]) {
      expect(validateProviderBaseUrl(u), u).toMatch(/Private/)
    }
  })

  it('rejects cloud metadata hostnames', () => {
    expect(validateProviderBaseUrl('https://metadata.google.internal/x')).toMatch(/metadata/i)
  })

  it('rejects malformed URLs', () => {
    expect(validateProviderBaseUrl('not a url')).toMatch(/Invalid/)
    expect(validateProviderBaseUrl('')).toMatch(/Invalid/)
  })
})
