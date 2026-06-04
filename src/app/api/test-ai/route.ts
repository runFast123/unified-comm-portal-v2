import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { validateProviderBaseUrl } from '@/lib/ssrf'

export async function POST(request: Request) {
  try {
    // Require authenticated user
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { base_url, api_key, model } = body

    if (!base_url || !api_key || !model) {
      return NextResponse.json(
        { error: 'Missing required fields: base_url, api_key, model' },
        { status: 400 }
      )
    }

    // SSRF protection: HTTPS only, DNS-resolved, no private/loopback/link-local
    // or cloud-metadata targets (shared strong validator — replaces the old
    // literal-hostname denylist that missed decimal/IPv6 literals + rebinding).
    const ssrfError = await validateProviderBaseUrl(base_url)
    if (ssrfError) {
      return NextResponse.json({ error: ssrfError }, { status: 400 })
    }

    // Call the AI API from the server (avoids CORS)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    const response = await fetch(`${base_url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${api_key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Say "Connection successful!" in exactly those words.' },
        ],
        temperature: 0.1,
        max_tokens: 50,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      return NextResponse.json(
        { error: `AI API returned error status ${response.status}` },
        { status: 502 }
      )
    }

    let data
    try {
      data = await response.json()
    } catch {
      return NextResponse.json(
        { error: 'AI API returned non-JSON response' },
        { status: 502 }
      )
    }
    const reply = data.choices?.[0]?.message?.content || 'No response content'

    return NextResponse.json({ message: reply }, { status: 200 })
  } catch (error) {
    // Log the full error server-side but never expose it to the client
    // (raw error messages from AI providers may contain the API key)
    console.error('AI test connection error:', error)
    return NextResponse.json(
      { error: 'Connection failed. Check server logs for details.' },
      { status: 500 }
    )
  }
}
