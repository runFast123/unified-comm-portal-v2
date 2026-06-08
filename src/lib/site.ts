/**
 * Canonical marketing-site constants. `metadataBase`, the sitemap, robots.txt
 * and the JSON-LD structured data all read from here so the deployed origin and
 * brand copy stay consistent in one place.
 *
 * In production set `NEXT_PUBLIC_SITE_URL` to the real domain (e.g.
 * https://unified.example.com). Otherwise we fall back to the Vercel-provided
 * production URL, then to localhost for local dev.
 */
function resolveSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
  if (vercel) return `https://${vercel}`
  return 'http://localhost:3000'
}

export const SITE_URL = resolveSiteUrl()

export const SITE_NAME = 'Unified Communication Portal'

export const SITE_SHORT_NAME = 'Unified'

export const SITE_TAGLINE = 'One AI inbox for every channel'

export const SITE_DESCRIPTION =
  'Unified Communication Portal brings email, Teams, WhatsApp, SMS, Telegram, Messenger, Instagram and website live chat into one AI-powered shared inbox — with smart routing, approval-gated AI replies, role-based access, bring-your-own-credentials and true multi-brand isolation for in-house teams and BPOs.'

/** Channels we unify — reused across marketing pages and structured data. */
export const CHANNELS = [
  'Email',
  'Microsoft Teams',
  'WhatsApp',
  'SMS',
  'Telegram',
  'Messenger',
  'Instagram',
  'Live Chat',
] as const

/**
 * Where the marketing "Request a demo" / contact form routes. The contact form
 * opens the visitor's mail client via a mailto: link (no backend needed), so
 * set `NEXT_PUBLIC_CONTACT_EMAIL` to your real inbox before launch.
 */
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim() || 'hello@unified.app'
