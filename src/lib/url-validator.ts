// ─── SSRF-resistant URL validator ────────────────────────────────────
//
// Used by outgoing webhook subscription endpoints to ensure customers
// cannot register URLs that point at:
//   - non-https (plain http, file://, gopher://, etc.)
//   - private/loopback/link-local IP ranges (RFC1918, 127/8, 169.254/16, …)
//   - internal hostnames (localhost, *.local, *.internal, *.consul)
//
// The check is intentionally strict — webhook targets should always be
// public, TLS-protected, public-internet endpoints. We resolve via DNS at
// validation time so a hostname mapping to 127.0.0.1 is rejected even
// though the literal string isn't an IP.
//
// NOTE: DNS rebinding is still possible — a hostname could resolve to a
// public IP at validation time and a private IP at dispatch time. The
// dispatcher should re-validate the resolved IP at request time. We mark
// that as a TODO at the call sites; this file only covers the registration
// surface.

import { promises as dns } from 'node:dns'
import net from 'node:net'

const MAX_URL_LEN = 2048

const BLOCKED_HOSTNAME_RE = /^(localhost|.*\.local|.*\.internal|.*\.consul)$/i

interface IpRange {
  cidr: string
  network: bigint
  prefix: number
}

// IPv4 ranges to block.
const IPV4_BLOCKLIST: ReadonlyArray<IpRange> = [
  parseV4Cidr('0.0.0.0/8'),
  parseV4Cidr('10.0.0.0/8'),
  parseV4Cidr('100.64.0.0/10'),
  parseV4Cidr('127.0.0.0/8'),
  parseV4Cidr('169.254.0.0/16'),
  parseV4Cidr('172.16.0.0/12'),
  parseV4Cidr('192.168.0.0/16'),
]

function parseV4Cidr(cidr: string): IpRange {
  const [addr, prefixStr] = cidr.split('/')
  const prefix = Number(prefixStr)
  return { cidr, network: ipv4ToBigInt(addr), prefix }
}

function ipv4ToBigInt(addr: string): bigint {
  const parts = addr.split('.').map((n) => Number(n))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`bad ipv4: ${addr}`)
  }
  return (
    (BigInt(parts[0]) << BigInt(24)) |
    (BigInt(parts[1]) << BigInt(16)) |
    (BigInt(parts[2]) << BigInt(8)) |
    BigInt(parts[3])
  )
}

function ipv4InRange(addr: string, range: IpRange): boolean {
  const v = ipv4ToBigInt(addr)
  const ZERO = BigInt(0)
  const ONE = BigInt(1)
  const mask =
    range.prefix === 0
      ? ZERO
      : ((ONE << BigInt(range.prefix)) - ONE) << BigInt(32 - range.prefix)
  return (v & mask) === (range.network & mask)
}

/**
 * Returns true if the given IPv4 string is in any blocked range.
 */
export function isBlockedIPv4(addr: string): boolean {
  try {
    return IPV4_BLOCKLIST.some((r) => ipv4InRange(addr, r))
  } catch {
    return true // unparseable IPv4 → block by default
  }
}

/**
 * Returns true if the given IPv6 string is in a blocked range.
 *
 * We block:
 *   - ::1            (loopback)
 *   - fc00::/7       (unique local addresses)
 *   - fe80::/10      (link-local)
 *   - ::ffff:0:0/96  (IPv4-mapped — re-check the embedded IPv4)
 */
export function isBlockedIPv6(addr: string): boolean {
  const lower = addr.toLowerCase()
  // Loopback
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true

  // IPv4-mapped: ::ffff:a.b.c.d → re-check IPv4 blocklist on the embedded addr.
  const v4MappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4MappedMatch) {
    return isBlockedIPv4(v4MappedMatch[1])
  }

  // Expand the address to compare prefix bits — Node's net module doesn't
  // expose CIDR, so we do a simple textual check on the leading hextets.
  // fc00::/7 → first byte in [0xfc, 0xfd]; fe80::/10 → first hextet starts
  // with `fe` and second hex digit is in [8..b].
  const firstHextet = lower.split(':')[0] || '0'
  const firstHextetNum = parseInt(firstHextet, 16)
  if (Number.isNaN(firstHextetNum)) return true
  const firstByte = (firstHextetNum >> 8) & 0xff
  if (firstByte === 0xfc || firstByte === 0xfd) return true // fc00::/7
  // fe80::/10 → first byte 0xfe AND second nibble of byte 1 in [0x8..0xb]
  if (firstByte === 0xfe) {
    const secondByte = firstHextetNum & 0xff
    if ((secondByte & 0xc0) === 0x80) return true
  }
  return false
}

/**
 * SSRF-resistant validator for outgoing webhook URLs.
 *
 *   - Requires `https://`.
 *   - Rejects malformed URLs.
 *   - Resolves the hostname via DNS and rejects when ANY resolved address
 *     falls in a private/loopback/link-local range.
 *   - Rejects hostnames matching localhost / *.local / *.internal / *.consul.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, error }` on rejection.
 *
 * TODO(dns-rebinding): the dispatcher should re-resolve and re-validate
 * the resolved IP at request-time, not just at registration. This helper
 * is the registration-time defence.
 */
export async function validatePublicHttpsUrl(
  input: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, error: 'url is required' }
  }
  if (input.length > MAX_URL_LEN) {
    return { ok: false, error: `url exceeds ${MAX_URL_LEN} chars` }
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return { ok: false, error: 'url is malformed' }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'url must use https://' }
  }

  const hostname = parsed.hostname
  if (!hostname) return { ok: false, error: 'url has no hostname' }

  // Strip surrounding brackets from IPv6 literals.
  const bareHost = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname

  // Block well-known internal-only hostnames before DNS lookup.
  if (BLOCKED_HOSTNAME_RE.test(bareHost)) {
    return { ok: false, error: 'hostname is reserved/internal' }
  }

  // If the hostname itself is an IP literal, validate it directly.
  const ipKind = net.isIP(bareHost)
  if (ipKind === 4) {
    if (isBlockedIPv4(bareHost)) {
      return { ok: false, error: 'IP is in a private/loopback/link-local range' }
    }
    return { ok: true }
  }
  if (ipKind === 6) {
    if (isBlockedIPv6(bareHost)) {
      return { ok: false, error: 'IPv6 is in a private/loopback/link-local range' }
    }
    return { ok: true }
  }

  // Hostname → resolve and check every returned address.
  let addresses: { address: string; family: number }[]
  try {
    addresses = await dns.lookup(bareHost, { all: true, verbatim: true })
  } catch {
    return { ok: false, error: 'hostname does not resolve' }
  }
  if (addresses.length === 0) {
    return { ok: false, error: 'hostname does not resolve' }
  }
  for (const a of addresses) {
    if (a.family === 4 && isBlockedIPv4(a.address)) {
      return { ok: false, error: 'hostname resolves to a private/loopback IP' }
    }
    if (a.family === 6 && isBlockedIPv6(a.address)) {
      return { ok: false, error: 'hostname resolves to a private/loopback IPv6' }
    }
  }
  return { ok: true }
}
