// Shared SSRF guard for ADMIN-supplied provider base URLs (AI providers).
//
// Mirrors the inline checks in /api/test-ai so every place that fetches an
// admin-entered endpoint applies the same policy: HTTPS only, no loopback /
// private / link-local ranges, no cloud-metadata hosts. Returns a human-
// readable error string when the URL must be rejected, or null when it's
// allowed.

const PRIVATE_HOST = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|localhost|::1|\[::1\])/
const METADATA_HOSTS = ['metadata.google.internal', 'metadata.aws', 'metadata.google']

export function validateProviderBaseUrl(baseUrl: string): string | null {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return 'Invalid URL format'
  }
  if (url.protocol !== 'https:') return 'Only HTTPS URLs are allowed'
  const hostname = url.hostname.toLowerCase()
  if (PRIVATE_HOST.test(hostname)) return 'Private/local URLs are not allowed'
  if (METADATA_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h))) {
    return 'Cloud metadata endpoints are not allowed'
  }
  return null
}
