import { describe, it, expect, vi } from 'vitest'

// validateProviderBaseUrl now delegates to the DNS-resolving validator, so we
// mock node:dns to make hostname resolution deterministic (and offline).
vi.mock('node:dns', () => ({
  promises: {
    lookup: vi.fn(async (host: string) => {
      if (host === 'api.openai.com') return [{ address: '104.18.0.1', family: 4 }]
      if (host === 'integrate.api.nvidia.com') return [{ address: '23.1.2.3', family: 4 }]
      // A hostname whose DNS A-record points at the cloud-metadata IP — the
      // classic SSRF rebinding the old literal denylist could not catch.
      if (host === 'rebind.attacker.test') return [{ address: '169.254.169.254', family: 4 }]
      throw new Error('ENOTFOUND')
    }),
  },
}))

import { validateProviderBaseUrl } from '@/lib/ssrf'

describe('validateProviderBaseUrl (SSRF guard for AI provider URLs)', () => {
  it('allows public HTTPS endpoints (by hostname and by public IP literal)', async () => {
    expect(await validateProviderBaseUrl('https://api.openai.com/v1')).toBeNull()
    expect(await validateProviderBaseUrl('https://integrate.api.nvidia.com/v1')).toBeNull()
    expect(await validateProviderBaseUrl('https://8.8.8.8/v1')).toBeNull()
  })

  it('rejects non-HTTPS', async () => {
    expect(await validateProviderBaseUrl('http://api.openai.com/v1')).toMatch(/https/i)
  })

  it('rejects loopback / private / link-local IP literals', async () => {
    for (const u of [
      'https://127.0.0.1/v1',
      'https://10.0.0.5/v1',
      'https://192.168.1.10/v1',
      'https://172.16.0.1/v1',
      'https://169.254.169.254/latest/meta-data', // AWS metadata IP
      'https://[::1]/v1', // IPv6 loopback
    ]) {
      expect(await validateProviderBaseUrl(u), u).not.toBeNull()
    }
  })

  it('rejects a hostname that RESOLVES to a private/metadata IP (DNS rebinding)', async () => {
    expect(await validateProviderBaseUrl('https://rebind.attacker.test/v1')).not.toBeNull()
  })

  it('rejects an internal-only hostname before DNS lookup', async () => {
    expect(await validateProviderBaseUrl('https://localhost/v1')).not.toBeNull()
  })

  it('rejects malformed URLs', async () => {
    expect(await validateProviderBaseUrl('not a url')).not.toBeNull()
    expect(await validateProviderBaseUrl('')).not.toBeNull()
  })
})
