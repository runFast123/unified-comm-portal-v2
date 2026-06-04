// POST /api/ai-providers/[id]/test
//
// Health-check a SAVED provider using its STORED api_key (never exposed to the
// browser) and persist the result on the row (last_tested_at / last_test_ok /
// last_test_error) so the AI Settings list can show a status badge. Company-
// admin only; the target row must belong to the caller's company (super_admin
// may test any). Raw provider errors are never returned (they can echo the key)
// — only a generic, safe message.

import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireCompanyAdmin } from '@/lib/tenant-guard'
import { validateProviderBaseUrl } from '@/lib/ssrf'

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { ctx } = gate
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const admin = await createServiceRoleClient()
  const { data: row } = await admin
    .from('ai_providers')
    .select('id, company_id, base_url, api_key, model')
    .eq('id', id)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  if (!ctx.isSuperAdmin && (row as { company_id: string }).company_id !== ctx.companyId) {
    return NextResponse.json({ error: 'Forbidden: company scope mismatch' }, { status: 403 })
  }

  const baseUrl = String((row as { base_url?: string }).base_url || '')
  const apiKey = String((row as { api_key?: string }).api_key || '')
  const model = String((row as { model?: string }).model || '')

  // Persist the outcome on the row (fire-and-forget; never blocks the response).
  const persist = async (ok: boolean, error: string | null) => {
    try {
      await admin
        .from('ai_providers')
        .update({
          last_tested_at: new Date().toISOString(),
          last_test_ok: ok,
          last_test_error: error ? error.slice(0, 300) : null,
        })
        .eq('id', id)
    } catch {
      /* non-critical */
    }
  }

  const ssrfError = await validateProviderBaseUrl(baseUrl)
  if (ssrfError) {
    await persist(false, ssrfError)
    return NextResponse.json({ ok: false, error: ssrfError }, { status: 200 })
  }
  if (!apiKey || !model) {
    const msg = 'Provider is missing an API key or model'
    await persist(false, msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 200 })
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      // Generic, key-safe message (a raw body could echo the key).
      const msg = `Provider returned HTTP ${res.status}`
      await persist(false, msg)
      return NextResponse.json({ ok: false, error: msg }, { status: 200 })
    }

    await persist(true, null)
    return NextResponse.json({ ok: true, message: 'Connection OK' })
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? 'Connection timed out'
        : 'Could not reach the provider'
    await persist(false, msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 200 })
  }
}
