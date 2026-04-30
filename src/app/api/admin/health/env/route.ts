import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/health/env
 *
 * Admin-only. Returns the PRESENCE (boolean only — never the value) of every
 * env var the app actually relies on, classified into "required" vs
 * "optional". Used by /admin/health to render a quick green/yellow/red grid
 * so the admin can see at a glance what's configured without ever exposing
 * a secret to the client bundle.
 *
 * Why server-side: many of these vars are server-only (no NEXT_PUBLIC_
 * prefix). The browser literally cannot read process.env for them, so we
 * have to do the check here.
 */
async function requireAdmin() {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  if (profile?.role !== 'admin') return { ok: false as const, status: 403, error: 'Admin only' }
  return { ok: true as const }
}

interface EnvCheck {
  name: string
  set: boolean
  /** When `set`, optional safe hint about the value's shape (e.g. last 4 chars
   *  of a Supabase URL, length of a key). NEVER the secret itself. */
  hint?: string | null
}

interface EnvReport {
  required: EnvCheck[]
  optional: EnvCheck[]
  /** Special case: encryption key may come from EITHER var; we report the
   *  effective state so the UI doesn't show a misleading "missing" for the
   *  one that's not set. */
  encryption_key: { set: boolean; source: 'CHANNEL_CONFIG_ENCRYPTION_KEYS' | 'CHANNEL_CONFIG_ENCRYPTION_KEY' | null }
}

function urlHint(value: string | undefined): string | null {
  if (!value) return null
  try {
    const u = new URL(value)
    return u.host
  } catch {
    return null
  }
}

function lengthHint(value: string | undefined): string | null {
  if (!value) return null
  return `${value.length} chars`
}

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const required: EnvCheck[] = [
    {
      name: 'NEXT_PUBLIC_SUPABASE_URL',
      set: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      hint: urlHint(process.env.NEXT_PUBLIC_SUPABASE_URL),
    },
    {
      name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      set: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      hint: lengthHint(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    },
    {
      name: 'SUPABASE_SERVICE_ROLE_KEY',
      set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      hint: lengthHint(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    {
      name: 'WEBHOOK_SECRET',
      set: !!process.env.WEBHOOK_SECRET,
      hint: lengthHint(process.env.WEBHOOK_SECRET),
    },
  ]

  // Encryption: either-or. Prefer the new CHANNEL_CONFIG_ENCRYPTION_KEYS
  // (key-ring format) but accept the legacy single-key var for back-compat.
  const newEnc = !!process.env.CHANNEL_CONFIG_ENCRYPTION_KEYS
  const legacyEnc = !!process.env.CHANNEL_CONFIG_ENCRYPTION_KEY
  const encryption_key: EnvReport['encryption_key'] = {
    set: newEnc || legacyEnc,
    source: newEnc
      ? 'CHANNEL_CONFIG_ENCRYPTION_KEYS'
      : legacyEnc
      ? 'CHANNEL_CONFIG_ENCRYPTION_KEY'
      : null,
  }

  const optional: EnvCheck[] = [
    { name: 'AI_API_KEY', set: !!process.env.AI_API_KEY, hint: lengthHint(process.env.AI_API_KEY) },
    {
      name: 'GOOGLE_OAUTH_CLIENT_ID',
      set: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
      hint: process.env.GOOGLE_OAUTH_CLIENT_ID
        ? `…${process.env.GOOGLE_OAUTH_CLIENT_ID.slice(-4)}`
        : null,
    },
    {
      name: 'GOOGLE_OAUTH_CLIENT_SECRET',
      set: !!process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      hint: lengthHint(process.env.GOOGLE_OAUTH_CLIENT_SECRET),
    },
    { name: 'AZURE_TENANT_ID', set: !!process.env.AZURE_TENANT_ID, hint: null },
    {
      name: 'AZURE_CLIENT_ID',
      set: !!process.env.AZURE_CLIENT_ID,
      hint: process.env.AZURE_CLIENT_ID ? `…${process.env.AZURE_CLIENT_ID.slice(-4)}` : null,
    },
    {
      name: 'AZURE_CLIENT_SECRET',
      set: !!process.env.AZURE_CLIENT_SECRET,
      hint: lengthHint(process.env.AZURE_CLIENT_SECRET),
    },
    { name: 'SENTRY_DSN', set: !!process.env.SENTRY_DSN, hint: null },
  ]

  const report: EnvReport = { required, optional, encryption_key }
  return NextResponse.json(report)
}
