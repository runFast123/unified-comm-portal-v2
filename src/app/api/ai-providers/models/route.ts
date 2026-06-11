// POST /api/ai-providers/models
//
// Fetches the LIVE model list from an OpenAI-compatible provider's `GET /models`
// endpoint so the AI Settings UI can offer a real dropdown instead of asking the
// admin to type a model name by hand.
//
// Accepts either:
//   { base_url, api_key }  — a provider being added/edited (key is in the form), or
//   { id, base_url? }      — an existing provider; the stored api_key is used
//                            server-side and never exposed to the browser.
//
// Company-scoped via the tenant guard (company admins only — it uses an API key
// and mirrors the existing /api/test-ai trust model: base_url is admin-supplied
// and fetched server-side).

import { NextResponse } from 'next/server'
import { requireCompanyAdmin } from '@/lib/tenant-guard'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { validateProviderBaseUrl } from '@/lib/ssrf'
import { decrypt, __parseCiphertextKeyId } from '@/lib/encryption'

interface Body {
  base_url?: string
  api_key?: string
  id?: string
}

export async function POST(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const body = (await request.json().catch(() => ({}))) as Body
  let baseUrl = (body.base_url || '').trim()
  let apiKey = (body.api_key || '').trim()

  // Resolve from a stored provider when an id is given — the saved key never
  // leaves the server, so editing a provider can still load its models without
  // re-typing the key.
  if (body.id) {
    const admin = await createServiceRoleClient()
    const { data: row } = await admin
      .from('ai_providers')
      .select('base_url, api_key, company_id')
      .eq('id', body.id)
      .maybeSingle()
    if (!row) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
    }
    // Tenant scope: a company admin may only read their own company's provider.
    if (!gate.ctx.isSuperAdmin && row.company_id !== gate.ctx.companyId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    baseUrl = baseUrl || ((row.base_url as string | null) ?? '')
    // Stored keys are encrypted at rest (v1:…); legacy rows may still be
    // plaintext. An undecryptable ciphertext falls through to the 400 below.
    let stored = (row.api_key as string | null) ?? ''
    if (stored && __parseCiphertextKeyId(stored) !== null) {
      try {
        stored = decrypt(stored)
      } catch {
        stored = ''
      }
    }
    apiKey = apiKey || stored
  }

  if (!baseUrl || !apiKey) {
    return NextResponse.json(
      { error: 'base_url and api_key are required (or an id for a saved provider)' },
      { status: 400 }
    )
  }

  // SSRF guard (same policy as /api/test-ai): HTTPS only, DNS-resolved, no
  // private/loopback/link-local/metadata targets.
  const ssrfError = await validateProviderBaseUrl(baseUrl)
  if (ssrfError) {
    return NextResponse.json({ error: ssrfError }, { status: 400 })
  }
  const url = new URL(baseUrl.replace(/\/+$/, '') + '/models')

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json(
        {
          error: `Provider returned ${res.status}${text ? `: ${text.slice(0, 180)}` : ''}. Check the base URL + API key, or type the model name manually.`,
        },
        { status: 502 }
      )
    }
    const json = (await res.json().catch(() => null)) as unknown
    // Normalize a few shapes: OpenAI `{ data: [{ id }] }`, a bare array, or
    // `{ models: [...] }` (string or { id }).
    const raw =
      (json as { data?: unknown[] })?.data ??
      (Array.isArray(json) ? json : undefined) ??
      (json as { models?: unknown[] })?.models ??
      []
    const list = Array.isArray(raw) ? raw : []
    const models = Array.from(
      new Set(
        list
          .map((m) => (typeof m === 'string' ? m : (m as { id?: string })?.id))
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
      )
    ).sort((a, b) => a.localeCompare(b))

    return NextResponse.json({ models })
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? `Could not reach the provider: ${err.message}`
            : 'Could not reach the provider',
      },
      { status: 502 }
    )
  }
}
