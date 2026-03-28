import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

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

    // SSRF protection: only allow HTTPS and block private IP ranges
    try {
      const url = new URL(base_url)
      if (url.protocol !== 'https:') {
        return NextResponse.json({ error: 'Only HTTPS URLs are allowed' }, { status: 400 })
      }
      const hostname = url.hostname
      const blocked = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|localhost|::1|\[::1\])/
      if (blocked.test(hostname)) {
        return NextResponse.json({ error: 'Private/local URLs are not allowed' }, { status: 400 })
      }
      // Block cloud metadata endpoints (SSRF protection)
      const blockedHostnames = ['metadata.google.internal', 'metadata.aws', 'metadata.google']
      if (blockedHostnames.some(h => hostname === h || hostname.endsWith('.' + h))) {
        return NextResponse.json({ error: 'Cloud metadata endpoints are not allowed' }, { status: 400 })
      }
    } catch {
      return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 })
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

    const data = await response.json()
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
