// Shared SSRF guard for ADMIN-supplied provider base URLs (AI providers).
//
// Delegates to the strong, DNS-resolving validator used for outbound webhooks
// (`validatePublicHttpsUrl` in src/lib/url-validator.ts) so that hostname →
// private-IP rebinding, decimal / IPv6-mapped literals, and cloud-metadata
// ranges are ALL caught — not just a literal-hostname denylist (which missed
// e.g. `https://2130706433` = 127.0.0.1, `https://[::ffff:169.254.169.254]`,
// or any public hostname whose DNS A-record points at a private IP).
//
// Returns a human-readable error string when the URL must be rejected, or null
// when it's allowed. Async because it performs a DNS lookup for hostnames.

import { validatePublicHttpsUrl } from '@/lib/url-validator'

export async function validateProviderBaseUrl(baseUrl: string): Promise<string | null> {
  const result = await validatePublicHttpsUrl(baseUrl)
  return result.ok ? null : result.error
}
