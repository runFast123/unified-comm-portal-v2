/**
 * POST /api/csat/[token]
 *
 * PUBLIC endpoint — no auth, no cookies. The HMAC-signed token in the URL
 * is the only credential. This is what the customer's browser hits when
 * they click "Submit" on the public landing page.
 *
 * Body: { rating: 1..5, feedback?: string }
 *
 * Returns:
 *   200 { ok: true }
 *   400 invalid body
 *   401 invalid / missing token
 *   404 survey not found
 *   409 already responded (one-time only)
 *   410 expired
 *
 * Uses the service-role client because the row's RLS doesn't allow
 * unauthenticated writes (and shouldn't — we want this single chokepoint).
 */

import { NextResponse } from 'next/server'
import { verifySurveyToken, recordResponse } from '@/lib/csat'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { checkRateLimit } from '@/lib/api-helpers'

interface PostBody {
  rating?: unknown
  feedback?: unknown
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params
    const surveyId = verifySurveyToken(token)
    if (!surveyId) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // Modest rate limit per token — protects against brute submitting.
    // Token is already specific enough that this only ever rate-limits a
    // single survey URL, never a real customer.
    const allowed = await checkRateLimit(`csat:${surveyId}`, 10, 60)
    if (!allowed) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    const body = (await request.json().catch(() => ({}))) as PostBody
    const rating = Number(body.rating)
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return NextResponse.json(
        { error: 'rating must be an integer between 1 and 5' },
        { status: 400 }
      )
    }
    const feedback =
      typeof body.feedback === 'string' ? body.feedback : null

    const admin = await createServiceRoleClient()
    const result = await recordResponse(admin, surveyId, rating, feedback)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('CSAT submit error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
